import assert from "node:assert/strict";
import test from "node:test";
import { HYPER_MAX_PAYLOAD_BYTES, OMITTED_IMAGE_PLACEHOLDER, optimizeHyperPayload } from "../src/payload.js";

test("Payload Optimization", async (t) => {
	await t.test("returns payload unchanged when below threshold", () => {
		const payload = {
			model: "deepseek-v4.1-flash",
			messages: [
				{ role: "user", content: "hello" },
				{
					role: "user",
					content: [
						{ type: "text", text: "check this:" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,abc1234" } },
					],
				},
			],
		};

		const result = optimizeHyperPayload(payload);
		assert.deepEqual(result, payload);
	});

	await t.test("prunes oldest images first when payload exceeds safe size", () => {
		// Create large fake base64 chunks (e.g. 3 MB each)
		const largeBase64 = "X".repeat(3_000_000);

		const payload = {
			model: "deepseek-v4.1-flash",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "First image" },
						{ type: "image_url", image_url: { url: `data:image/png;base64,${largeBase64}` } },
					],
				},
				{
					role: "assistant",
					content: "I see the first image.",
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "Second image" },
						{ type: "image_url", image_url: { url: `data:image/png;base64,${largeBase64}` } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "Third image" },
						{ type: "image_url", image_url: { url: `data:image/png;base64,${largeBase64}` } },
					],
				},
			],
		};

		const initialSize = JSON.stringify(payload).length;
		assert.ok(initialSize > HYPER_MAX_PAYLOAD_BYTES, `Initial size ${initialSize} should exceed limit`);

		const optimized = optimizeHyperPayload(payload);
		const finalSize = JSON.stringify(optimized).length;

		assert.ok(finalSize <= HYPER_MAX_PAYLOAD_BYTES, `Final size ${finalSize} should be <= ${HYPER_MAX_PAYLOAD_BYTES}`);

		// First image (oldest) should be replaced with placeholder
		const msg0 = optimized.messages[0];
		assert.equal(msg0.content[1].type, "text");
		assert.equal(msg0.content[1].text, OMITTED_IMAGE_PLACEHOLDER);

		// Third image (newest) should still be an image_url
		const msg3 = optimized.messages[3];
		assert.equal(msg3.content[1].type, "image_url");
		assert.equal(msg3.content[1].image_url.url, `data:image/png;base64,${largeBase64}`);
	});

	await t.test("handles malformed/empty payload gracefully", () => {
		assert.deepEqual(optimizeHyperPayload(null as unknown as HyperChatPayload), null);
		assert.deepEqual(optimizeHyperPayload({} as unknown as HyperChatPayload), {});
		assert.deepEqual(optimizeHyperPayload({ messages: [] } as unknown as HyperChatPayload), { messages: [] });
	});
});
