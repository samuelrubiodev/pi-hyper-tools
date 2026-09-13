import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { updateCachedHyperModels } from "../src/models.js";
import { createTracker, parseRateLimitHeaders, startOfLocalDay, startOfLocalHour } from "../src/tracking.js";

describe("Dynamic Server Rate Limits & Local Request Tracking", () => {
	it("calculates start of local hour accurately", () => {
		const d = new Date(2026, 7, 31, 14, 35, 22, 500);
		const hourStart = startOfLocalHour(d);
		const expected = new Date(2026, 7, 31, 14, 0, 0, 0).getTime();
		assert.equal(hourStart, expected);
	});

	it("calculates start of local day accurately", () => {
		const d = new Date(2026, 7, 31, 14, 35, 22, 500);
		const dayStart = startOfLocalDay(d);
		const expected = new Date(2026, 7, 31, 0, 0, 0, 0).getTime();
		assert.equal(dayStart, expected);
	});

	it("Test 1: parses standard rate limit headers", () => {
		const headers = {
			"x-ratelimit-limit-hour": "1000",
			"x-ratelimit-limit-day": "10000",
			"x-ratelimit-remaining-hour": "986",
			"x-ratelimit-remaining-day": "9976",
		};

		const parsed = parseRateLimitHeaders(headers);
		assert.equal(parsed.limitHour, 1000);
		assert.equal(parsed.limitDay, 10000);
		assert.equal(parsed.remainingHour, 986);
		assert.equal(parsed.remainingDay, 9976);
		assert.ok(parsed.lastUpdatedAt !== undefined);
	});

	it("Test 2: parses free-tier style limits without assuming Shred limits", () => {
		const headers = {
			"x-ratelimit-limit-hour": "200",
			"x-ratelimit-limit-day": "1000",
			"x-ratelimit-remaining-hour": "182",
			"x-ratelimit-remaining-day": "387",
		};

		const tracker = createTracker({ inMemory: true });
		const limits = tracker.updateServerRateLimits(headers);

		assert.equal(limits.limitHour, 200);
		assert.equal(limits.limitDay, 1000);
		assert.equal(limits.remainingHour, 182);
		assert.equal(limits.remainingDay, 387);
	});

	it("Test 3: handles mixed/missing headers and preserves previous values", () => {
		const tracker = createTracker({ inMemory: true });

		// First response with full headers
		tracker.updateServerRateLimits({
			"x-ratelimit-limit-hour": "1000",
			"x-ratelimit-limit-day": "10000",
			"x-ratelimit-remaining-hour": "950",
			"x-ratelimit-remaining-day": "9900",
		});

		// Subsequent response with only remaining-hour
		const updated = tracker.updateServerRateLimits({
			"x-ratelimit-remaining-hour": "949",
		});

		assert.equal(updated.limitHour, 1000);
		assert.equal(updated.limitDay, 10000);
		assert.equal(updated.remainingHour, 949);
		assert.equal(updated.remainingDay, 9900);
	});

	it("Test 4: parses case-insensitive header names", () => {
		const headers = {
			"X-RateLimit-Limit-Hour": "500",
			"X-RATELIMIT-LIMIT-DAY": "5000",
			"x-RateLimit-Remaining-Hour": "480",
			"X-ratelimit-REMAINING-day": "4800",
		};

		const parsed = parseRateLimitHeaders(headers);
		assert.equal(parsed.limitHour, 500);
		assert.equal(parsed.limitDay, 5000);
		assert.equal(parsed.remainingHour, 480);
		assert.equal(parsed.remainingDay, 4800);
	});

	it("Test 5: ignores malformed non-numeric values safely", () => {
		const headers = {
			"x-ratelimit-limit-hour": "invalid_number",
			"x-ratelimit-limit-day": "-50",
			"x-ratelimit-remaining-hour": "",
			"x-ratelimit-remaining-day": "100",
		};

		const parsed = parseRateLimitHeaders(headers);
		assert.equal(parsed.limitHour, undefined);
		assert.equal(parsed.limitDay, undefined);
		assert.equal(parsed.remainingHour, undefined);
		assert.equal(parsed.remainingDay, 100);
	});

	it("Test 6: persistence and restoration of server limits & records", () => {
		const tmpFile = path.join(os.tmpdir(), `hyper-test-store-${Date.now()}.json`);
		try {
			const tracker1 = createTracker({ storagePath: tmpFile });
			tracker1.updateServerRateLimits({
				"x-ratelimit-limit-hour": "200",
				"x-ratelimit-remaining-hour": "150",
			});
			tracker1.recordRequest({
				model: "deepseek-v4-flash",
				usage: { inputTokens: 50, cachedTokens: 0, outputTokens: 25 },
			});

			// Re-create tracker pointing to same file
			const tracker2 = createTracker({ storagePath: tmpFile });
			const limits = tracker2.getServerRateLimits();
			assert.equal(limits.limitHour, 200);
			assert.equal(limits.remainingHour, 150);

			const summary = tracker2.getSummary();
			assert.equal(summary.localDailyRequests, 1);
			assert.equal(summary.today.inputTokens, 50);
		} finally {
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});

	it("Test 7: inference requests increment local counter while credits/models do not", () => {
		const tracker = createTracker({ inMemory: true });

		// Initial state
		let summary = tracker.getSummary();
		assert.equal(summary.localHourlyRequests, 0);

		// Record an inference request
		tracker.recordRequest({
			model: "deepseek-v4-flash",
			usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 20 },
		});

		summary = tracker.getSummary();
		assert.equal(summary.localHourlyRequests, 1);
		assert.equal(summary.session.requests, 1);

		// Non-inference operations only update rate limits if headers arrive, but do not call recordRequest
		tracker.updateServerRateLimits({
			"x-ratelimit-remaining-hour": "199",
		});

		summary = tracker.getSummary();
		assert.equal(summary.localHourlyRequests, 1);
		assert.equal(summary.session.requests, 1);
	});

	it("Test 8: captures both estimated and server-reported actual costs independently", () => {
		updateCachedHyperModels([
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				cost_per_1m_in: 0.2,
				cost_per_1m_out: 0.4,
				cost_per_1m_in_cached: 0,
				cost_per_1m_out_cached: 0.04,
				context_window: 1000000,
				default_max_tokens: 8192,
				can_reason: true,
				supports_attachments: false,
			},
		]);

		const tracker = createTracker({ inMemory: true });

		tracker.recordRequest({
			model: "deepseek-v4-flash",
			usage: {
				inputTokens: 10,
				cachedTokens: 0,
				outputTokens: 69,
				reasoningTokens: 65,
				actualCostUsd: 0.0001,
				actualCostHc: 0.002,
			},
		});

		const summary = tracker.getSummary();
		assert.equal(summary.session.requests, 1);
		assert.equal(summary.session.actualCostUsd, 0.0001);
		assert.equal(summary.session.actualCostHc, 0.002);
		assert.ok(summary.session.costUsd > 0);
	});

	it("Test 9: syncSessionFromEntries reconstructs session stats from SessionEntry array", () => {
		const tracker = createTracker({ inMemory: true });

		const entries = [
			{
				type: "message",
				id: "msg-1",
				parentId: null,
				timestamp: "2026-09-13T09:40:00.000Z",
				message: {
					role: "user",
					content: "Hello",
				},
			},
			{
				type: "message",
				id: "msg-2",
				parentId: "msg-1",
				timestamp: "2026-09-13T09:40:05.000Z",
				message: {
					role: "assistant",
					provider: "hyper",
					model: "deepseek-v4-flash",
					responseModel: "deepseek-v4-flash",
					usage: {
						input: 1000,
						cacheRead: 9000,
						cacheWrite: 0,
						output: 500,
						reasoning: 200,
						totalTokens: 10500,
						cost: {
							input: 0.0002,
							output: 0.0002,
							total: 0.0005,
						},
					},
				},
			},
			{
				type: "message",
				id: "msg-3",
				parentId: "msg-2",
				timestamp: "2026-09-13T09:41:00.000Z",
				message: {
					role: "assistant",
					provider: "hyper",
					model: "deepseek-v4-flash",
					usage: {
						input: 500,
						cacheRead: 9500,
						cacheWrite: 0,
						output: 250,
						reasoning: 100,
						totalTokens: 10250,
						cost: {
							total: 0.0003,
						},
					},
				},
			},
		];

		const stats = tracker.syncSessionFromEntries(entries, "session-123");

		assert.equal(stats.requests, 2);
		assert.equal(stats.inputTokens, 1500);
		assert.equal(stats.cachedTokens, 18500);
		assert.equal(stats.outputTokens, 750);
		assert.equal(stats.reasoningTokens, 300);
		assert.equal(stats.totalTokens, 20750);
		assert.equal(stats.actualCostUsd?.toFixed(4), "0.0008");
		assert.equal(stats.actualCostHc?.toFixed(4), (0.0008 * 20).toFixed(4));
		// Cache hit rate: 18500 / (18500 + 1500) = 18500 / 20000 = 0.925 (92.5%)
		assert.equal(stats.cacheHitRate, 0.925);

		// Verify getSummary().session matches
		const summary = tracker.getSummary();
		assert.equal(summary.session.requests, 2);
		assert.equal(summary.session.totalTokens, 20750);
		assert.equal(summary.session.cacheHitRate, 0.925);
	});

	it("Test 10: syncSessionFromEntries ignores zero-token aborted turns", () => {
		const tracker = createTracker({ inMemory: true });

		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "hyper",
					model: "deepseek-v4-flash",
					usage: {
						input: 0,
						cacheRead: 0,
						output: 0,
						totalTokens: 0,
					},
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "hyper",
					model: "deepseek-v4-flash",
					usage: {
						input: 100,
						cacheRead: 200,
						output: 50,
						totalTokens: 350,
					},
				},
			},
		];

		const stats = tracker.syncSessionFromEntries(entries);
		assert.equal(stats.requests, 1);
		assert.equal(stats.totalTokens, 350);
	});

	it("Test 11: syncSessionFromEntries ignores non-Hyper messages", () => {
		const tracker = createTracker({ inMemory: true });

		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-3-5-sonnet",
					usage: {
						input: 500,
						output: 200,
						totalTokens: 700,
					},
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-4o",
					usage: {
						input: 500,
						output: 200,
						totalTokens: 700,
					},
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "hyper",
					model: "deepseek-v4-flash",
					usage: {
						input: 300,
						output: 100,
						totalTokens: 400,
					},
				},
			},
		];

		const stats = tracker.syncSessionFromEntries(entries);
		assert.equal(stats.requests, 1);
		assert.equal(stats.inputTokens, 300);
		assert.equal(stats.outputTokens, 100);
	});

	it("Test 12: syncSessionFromEntries falls back to usage.json when entries is empty", () => {
		const tmpFile = path.join(os.tmpdir(), `hyper-test-fallback-${Date.now()}.json`);
		try {
			const tracker = createTracker({ storagePath: tmpFile });

			// Record requests belonging to session A and session B
			tracker.recordRequest({
				sessionId: "sess-A",
				model: "deepseek-v4-flash",
				usage: { inputTokens: 200, cachedTokens: 800, outputTokens: 100, costUsd: 0.0005 },
			});
			tracker.recordRequest({
				sessionId: "sess-B",
				model: "deepseek-v4-flash",
				usage: { inputTokens: 50, cachedTokens: 0, outputTokens: 25, costUsd: 0.0001 },
			});

			// Re-create tracker pointing to same file (simulating restarting Pi next day)
			const tracker2 = createTracker({ storagePath: tmpFile });
			assert.equal(tracker2.getSessionStats().requests, 0);

			// Sync session A with empty entries array
			const statsA = tracker2.syncSessionFromEntries([], "sess-A");
			assert.equal(statsA.requests, 1);
			assert.equal(statsA.inputTokens, 200);
			assert.equal(statsA.cachedTokens, 800);
			assert.equal(statsA.outputTokens, 100);
			assert.equal(statsA.actualCostUsd, 0.0005);

			// Reset session
			tracker2.resetSession();
			assert.equal(tracker2.getSessionStats().requests, 0);
		} finally {
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});

	it("Test 13: recordRequest persists sessionId and survives reload", () => {
		const tmpFile = path.join(os.tmpdir(), `hyper-test-sessionid-${Date.now()}.json`);
		try {
			const tracker1 = createTracker({ storagePath: tmpFile });
			tracker1.recordRequest({
				sessionId: "my-custom-session-id",
				model: "deepseek-v4-flash",
				usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50 },
			});

			const tracker2 = createTracker({ storagePath: tmpFile });
			const stats = tracker2.syncSessionFromEntries([], "my-custom-session-id");
			assert.equal(stats.requests, 1);
			const raw = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
			assert.equal(raw.records.length, 1);
			assert.equal(raw.records[0].sessionId, "my-custom-session-id");
		} finally {
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});

	it("Test 14: syncSessionFromEntries parses real session file correctly if present", () => {
		const sessionPath =
			"/home/samuel/.pi/agent/sessions/--home-samuel-Documents-blender-HalconMilenarioDeepseekV4.1Flash--/2026-09-13T09-40-30-153Z_01a09a23-c348-75b8-8214-862ee23f4030.jsonl";
		if (!fs.existsSync(sessionPath)) {
			return; // Skip if file not present on this machine
		}

		const lines = fs.readFileSync(sessionPath, "utf-8").trim().split("\n");
		const entries = lines.map((l) => JSON.parse(l));

		const tracker = createTracker({ inMemory: true });
		const stats = tracker.syncSessionFromEntries(entries, "01a09a23-c348-75b8-8214-862ee23f4030");

		assert.equal(stats.requests, 103);
		assert.equal(stats.inputTokens, 514815);
		assert.equal(stats.cachedTokens, 11447694);
		assert.equal(stats.outputTokens, 188634);
		assert.equal(stats.reasoningTokens, 86491);
		assert.equal(stats.totalTokens, 12151143);
		assert.ok(stats.cacheHitRate > 0.95);
		assert.ok((stats.actualCostHc ?? 0) > 14);
	});
});
