#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <termios.h>
#include <unistd.h>

#define BUFFER_SIZE 65536

static volatile sig_atomic_t stopped;
static volatile sig_atomic_t resized;
static unsigned char to_host[BUFFER_SIZE];
static unsigned char to_tty[BUFFER_SIZE];

static void handle_signal(int signal_number) {
    if (signal_number == SIGWINCH) resized = 1;
    else stopped = 1;
}

static void put16(unsigned char *out, unsigned int value) {
    out[0] = (unsigned char)(value >> 8);
    out[1] = (unsigned char)value;
}

static void put32(unsigned char *out, uint32_t value) {
    out[0] = (unsigned char)(value >> 24);
    out[1] = (unsigned char)(value >> 16);
    out[2] = (unsigned char)(value >> 8);
    out[3] = (unsigned char)value;
}

static void dimensions(unsigned char *out) {
    struct winsize size = {0};
    if (ioctl(STDIN_FILENO, TIOCGWINSZ, &size) < 0) size.ws_col = size.ws_row = 0;
    put16(out, size.ws_col ? size.ws_col : 80);
    put16(out + 2, size.ws_row ? size.ws_row : 24);
}

static int retryable(void) {
    return errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK;
}

int main(int argc, char **argv) {
    struct sockaddr_un address = {0};
    if (argc != 3 || strlen(argv[1]) >= sizeof(address.sun_path) || strlen(argv[2]) != 64) {
        fprintf(stderr, "usage: omp-pane-relay <socket-path> <token>\n");
        return 1;
    }
    for (size_t i = 0; i < 64; i++) {
        if (!((argv[2][i] >= '0' && argv[2][i] <= '9') || (argv[2][i] >= 'a' && argv[2][i] <= 'f'))) return 1;
    }
    struct termios saved;
    if (tcgetattr(STDIN_FILENO, &saved) < 0 || !isatty(STDOUT_FILENO)) return 1;
    int input_flags = fcntl(STDIN_FILENO, F_GETFL);
    int output_flags = fcntl(STDOUT_FILENO, F_GETFL);
    if (input_flags < 0 || output_flags < 0) return 1;
    int connection = socket(AF_UNIX, SOCK_STREAM, 0);
    if (connection < 0) return 1;
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, argv[1], strlen(argv[1]) + 1);
    if (connect(connection, (struct sockaddr *)&address, sizeof(address)) < 0) {
        close(connection);
        return 1;
    }
    struct sigaction action = {0};
    action.sa_handler = handle_signal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGWINCH, &action, NULL) < 0 || sigaction(SIGHUP, &action, NULL) < 0 ||
        sigaction(SIGTERM, &action, NULL) < 0 || sigaction(SIGINT, &action, NULL) < 0) {
        close(connection);
        return 1;
    }
    signal(SIGPIPE, SIG_IGN);
    struct termios raw = saved;
    cfmakeraw(&raw);
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) < 0) { close(connection); return 1; }
    if (fcntl(STDIN_FILENO, F_SETFL, input_flags | O_NONBLOCK) < 0 ||
        fcntl(STDOUT_FILENO, F_SETFL, output_flags | O_NONBLOCK) < 0 ||
        fcntl(connection, F_SETFL, O_NONBLOCK) < 0) goto restore;

    to_host[0] = 1;
    put32(to_host + 1, 74);
    put16(to_host + 5, 1);
    dimensions(to_host + 7);
    put32(to_host + 11, (uint32_t)getpid());
    memcpy(to_host + 15, argv[2], 64);
    size_t host_start = 0, host_end = 79;
    size_t tty_start = 0, tty_end = 0;
    while (!stopped) {
        if (resized && host_start == host_end) {
            resized = 0;
            to_host[0] = 3;
            put32(to_host + 1, 4);
            dimensions(to_host + 5);
            host_start = 0;
            host_end = 9;
        }
        struct pollfd descriptors[3] = {
            {STDIN_FILENO, host_start == host_end ? POLLIN : 0, 0},
            {connection, (short)((tty_start == tty_end ? POLLIN : 0) | (host_start < host_end ? POLLOUT : 0)), 0},
            {STDOUT_FILENO, tty_start < tty_end ? POLLOUT : 0, 0}
        };
        int ready = poll(descriptors, 3, 100);
        if (ready < 0) { if (errno == EINTR) continue; break; }
        if (descriptors[1].revents & POLLOUT) {
            ssize_t count = write(connection, to_host + host_start, host_end - host_start);
            if (count > 0) host_start += (size_t)count;
            else if (count == 0 || !retryable()) break;
        }
        if (descriptors[2].revents & POLLOUT) {
            ssize_t count = write(STDOUT_FILENO, to_tty + tty_start, tty_end - tty_start);
            if (count > 0) tty_start += (size_t)count;
            else if (count == 0 || !retryable()) break;
        }
        if ((descriptors[1].revents & (POLLIN | POLLHUP)) && tty_start == tty_end) {
            ssize_t count = read(connection, to_tty, sizeof(to_tty));
            if (count > 0) { tty_start = 0; tty_end = (size_t)count; }
            else if (count == 0 || !retryable()) break;
        }
        if ((descriptors[0].revents & (POLLIN | POLLHUP)) && host_start == host_end) {
            ssize_t count = read(STDIN_FILENO, to_host + 5, sizeof(to_host) - 5);
            if (count > 0) {
                to_host[0] = 2;
                put32(to_host + 1, (uint32_t)count);
                host_start = 0;
                host_end = (size_t)count + 5;
            } else if (count == 0 || !retryable()) break;
        }
        if ((descriptors[0].revents | descriptors[1].revents | descriptors[2].revents) & (POLLERR | POLLNVAL)) break;
    }
restore:
    close(connection);
    tcsetattr(STDIN_FILENO, TCSANOW, &saved);
    fcntl(STDIN_FILENO, F_SETFL, input_flags);
    fcntl(STDOUT_FILENO, F_SETFL, output_flags);
    return 0;
}
