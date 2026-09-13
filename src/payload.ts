/**
 * Maximum safe JSON payload size for Hyper requests.
 * Hyper's gateway enforces an HTTP request body limit of ~10 MB.
 * Payloads above this threshold trigger HTTP 400 "invalid request body".
 * We use 7.5 MB as the safe threshold to ensure reliable delivery.
 */
export const HYPER_MAX_PAYLOAD_BYTES = 7_500_000;

export const OMITTED_IMAGE_PLACEHOLDER = "[Historical image attachment omitted to fit provider request payload limits]";

export interface PayloadMessagePart {
	type?: string;
	text?: string;
	image_url?: { url?: string };
	[key: string]: unknown;
}

export interface PayloadMessage {
	role?: string;
	content?: string | PayloadMessagePart[] | null;
	[key: string]: unknown;
}

export interface HyperChatPayload {
	messages?: PayloadMessage[];
	[key: string]: unknown;
}

/**
 * Optimizes the outgoing provider payload for Hyper inference requests.
 * If total serialized payload size exceeds HYPER_MAX_PAYLOAD_BYTES,
 * prunes older image attachments starting from the oldest, preserving
 * the most recent images.
 */
export function optimizeHyperPayload<T extends HyperChatPayload>(payload: T): T {
	if (!payload || !Array.isArray(payload.messages)) {
		return payload;
	}

	let jsonStr = JSON.stringify(payload);
	if (jsonStr.length <= HYPER_MAX_PAYLOAD_BYTES) {
		return payload;
	}

	// Deep clone payload so we do not mutate external state directly
	const cloned = JSON.parse(jsonStr) as T;
	const messages = cloned.messages;
	if (!messages) {
		return payload;
	}

	// Collect all image positions [messageIndex, partIndex]
	const imagePositions: Array<{ msgIndex: number; partIndex: number }> = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (Array.isArray(msg?.content)) {
			for (let j = 0; j < msg.content.length; j++) {
				const part = msg.content[j];
				if (part && part.type === "image_url") {
					imagePositions.push({ msgIndex: i, partIndex: j });
				}
			}
		}
	}

	if (imagePositions.length === 0) {
		return payload;
	}

	// Prune from oldest to newest until the payload fits within the safe limit
	for (let k = 0; k < imagePositions.length; k++) {
		if (jsonStr.length <= HYPER_MAX_PAYLOAD_BYTES) {
			break;
		}

		const { msgIndex, partIndex } = imagePositions[k];
		const msg = messages[msgIndex];
		if (Array.isArray(msg?.content)) {
			msg.content[partIndex] = {
				type: "text",
				text: OMITTED_IMAGE_PLACEHOLDER,
			};
			jsonStr = JSON.stringify(cloned);
		}
	}

	return cloned;
}
