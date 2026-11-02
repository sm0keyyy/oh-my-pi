import { expect, test } from "bun:test";
import { ScrollFollow } from "../src/scroll-follow";

test("an upward gesture detaches before the browser scrolls, even within one pixel of latest", () => {
	const follower = new ScrollFollow();
	const node = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
	follower.follow(node);
	expect(node.scrollTop).toBe(600);
	follower.detach();
	follower.track(node);
	expect(follower.isFollowing).toBe(false);
	node.scrollTop -= 0.5;
	follower.track(node);
	node.scrollHeight += 100;
	follower.follow(node);
	expect(node.scrollTop).toBe(599.5);
	expect(follower.isFollowing).toBe(false);
});

test("downward scrolling reattaches only at the bottom, then follows new output", () => {
	const follower = new ScrollFollow();
	const node = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
	follower.follow(node);
	node.scrollTop = 580;
	follower.track(node);
	expect(follower.isFollowing).toBe(false);
	node.scrollTop = 590;
	follower.track(node);
	expect(follower.isFollowing).toBe(false);
	node.scrollTop = 600;
	follower.track(node);
	node.scrollHeight = 1100;
	follower.follow(node);
	expect(node.scrollTop).toBe(700);
});

test("Jump to latest reattaches without a gesture or scroll event", () => {
	const follower = new ScrollFollow();
	const node = { scrollTop: 40, scrollHeight: 1500, clientHeight: 500 };
	follower.detach();
	follower.jump(node);
	expect(node.scrollTop).toBe(1000);
	node.scrollHeight = 1600;
	follower.follow(node);
	expect(node.scrollTop).toBe(1100);
});

test("keyboard and viewport resize preserve the reader position and follow state", () => {
	const follower = new ScrollFollow();
	const node = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
	follower.follow(node);
	node.clientHeight = 200;
	follower.track(node);
	expect(node.scrollTop).toBe(600);
	expect(follower.isFollowing).toBe(true);
	follower.detach();
	node.clientHeight = 500;
	node.scrollTop = 500;
	follower.track(node);
	expect(follower.isFollowing).toBe(false);
	node.scrollHeight = 1200;
	follower.follow(node);
	expect(node.scrollTop).toBe(500);
});

test("an empty transcript follows without a negative scroll position", () => {
	const follower = new ScrollFollow();
	const node = { scrollTop: 0, scrollHeight: 0, clientHeight: 400 };
	follower.follow(node);
	expect(node.scrollTop).toBe(0);
	follower.detach();
	node.scrollHeight = 500;
	follower.follow(node);
	expect(node.scrollTop).toBe(0);
	follower.jump(node);
	expect(node.scrollTop).toBe(100);
});
