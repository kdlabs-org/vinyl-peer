/**
 * ─────────────────────────────────────────────────────────────────────────────
 *   Type Definitions for VPlugin (per application "appId")
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** A single micro‐post (up to 280 characters). */
export interface MicroPost {
  postId: string; // "<handle>-<timestamp>-<uuid>"
  author: string; // handle
  peerId: string; // libp2p PeerId
  text: string; // up to 280 chars (or poll reference)
  createdAt: string; // ISO timestamp
  isPoll?: boolean; // true if this post represents a poll
}

/** A comment on a post. */
export interface CommentRecord {
  commentId: string; // "<postId>-comment-<uuid>"
  postId: string; // where this comment lives
  author: string; // handle
  peerId: string; // libp2p PeerId
  text: string; // comment text (≤280 chars)
  createdAt: string; // ISO timestamp
}

/** Like/Dislike record for a single post by a single user. */
export interface LikeRecord {
  postId: string;
  handle: string;
  peerId: string;
  isLike: boolean; // true = like, false = dislike
  createdAt: string; // ISO timestamp
}

/** A poll attached to a post. */
export interface PollOption {
  optionId: string; // UUID
  text: string; // Option text
  voteCount: number;
}

export interface PollRecord {
  pollId: string; // "<postId>-poll"
  postId: string; // which post triggered this poll
  question: string;
  options: PollOption[]; // initial options
  createdAt: string; // ISO timestamp
  expiresAt?: string; // optional expiry
}

/** A vote cast by a user on a poll. */
export interface VoteRecord {
  pollId: string;
  optionId: string;
  handle: string;
  peerId: string;
  createdAt: string; // ISO timestamp
}

/** Follow/unfollow events (re-used from older). */
export interface FollowEvent {
  type: "follow" | "unfollow";
  from: string; // actor handle
  to: string; // target handle
  timestamp: string;
}

/** A ban record—when one handle bans another. */
export interface BanRecord {
  actor: string; // handle who issued the ban
  target: string; // handle being banned
  timestamp: string; // ISO
}

/** Identity record linking a stable handle to libp2p PeerIds. */
export interface IdentityRecord {
  handle: string; // e.g. "alice"
  currentPeerId: string; // active PeerId
  previousPeerIds: string[]; // prior PeerIds
  createdAt: string;
  sig: string; // signature by previous key (or self if new)
}

/** PubSub events */
export interface NewPostEvent {
  type: "newPost";
  post: MicroPost;
}
export interface NewCommentEvent {
  type: "newComment";
  comment: CommentRecord;
}
export interface NewLikeEvent {
  type: "newLike";
  like: LikeRecord;
}
export interface NewPollEvent {
  type: "newPoll";
  poll: PollRecord;
}
export interface NewVoteEvent {
  type: "newVote";
  vote: VoteRecord;
}
export interface FollowPubEvent extends FollowEvent {}
export interface BanPubEvent {
  type: "ban";
  actor: string;
  target: string;
  timestamp: string;
}
