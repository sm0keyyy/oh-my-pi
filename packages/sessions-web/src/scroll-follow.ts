interface ScrollPosition {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

export class ScrollFollow {
	isFollowing = true;
	#top = 0;
	#height = 0;
	atBottomStateChange(atBottom: boolean): void {
		if (atBottom) this.isFollowing = true;
	}
	detach(): void {
		this.isFollowing = false;
	}
	track(node: ScrollPosition): void {
		if (node.clientHeight === this.#height) {
			if (node.scrollTop < this.#top) this.detach();
			else if (node.scrollTop > this.#top && node.scrollHeight - node.scrollTop - node.clientHeight <= 1)
				this.isFollowing = true;
		}
		this.#top = node.scrollTop;
		this.#height = node.clientHeight;
	}
	follow(node: ScrollPosition): void {
		if (this.isFollowing) node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
		this.#top = node.scrollTop;
		this.#height = node.clientHeight;
	}
	jump(node: ScrollPosition): void {
		this.isFollowing = true;
		this.follow(node);
	}
}
