import {
	createProvider,
	envApiKeyAuth,
	lazyOAuth,
	type OAuthAuth,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createHyperAutocompleteProvider,
	getHyperArgumentCompletions,
	getHyperStatusArgumentCompletions,
} from "./autocomplete.js";
import { type CreditStatusRuntime, formatCredits } from "./credits.js";
import {
	renderCreditsMessage,
	renderDashboardBox,
	renderHelpMessage,
	renderRequestsMessage,
	renderStatsMessage,
} from "./dashboard.js";
import { HYPER_API_BASE_URL, HYPERCREDITS_PER_USD, PROVIDER_DISPLAY_NAME, PROVIDER_NAME } from "./hyper.js";
import { fetchHyperModels, getCachedRawModel } from "./models.js";
import { createNotifier } from "./notify.js";
import { type HyperChatPayload, optimizeHyperPayload } from "./payload.js";
import { createTracker, type Tracker } from "./tracking.js";

type CreditStatusState =
	| { kind: "idle" }
	| { kind: "loading"; operation: Promise<CreditStatusRuntime> }
	| { kind: "ready"; runtime: CreditStatusRuntime }
	| { kind: "disposed" };

type PendingCreditStatusRefresh = {
	ctx: ExtensionContext;
	model: ExtensionContext["model"];
};

export default function (pi: ExtensionAPI) {
	const notifier = createNotifier();
	const tracker: Tracker = createTracker(notifier.warn);
	let creditStatusState: CreditStatusState = { kind: "idle" };
	let pendingCreditStatusRefresh: PendingCreditStatusRefresh | undefined;
	let creditStatusRefreshWork: ReturnType<typeof setImmediate> | undefined;

	function loadCreditStatus(): Promise<CreditStatusRuntime> {
		if (creditStatusState.kind === "ready") return Promise.resolve(creditStatusState.runtime);
		if (creditStatusState.kind === "loading") return creditStatusState.operation;
		if (creditStatusState.kind === "disposed") {
			return Promise.reject(new Error("Hyper status support was disposed"));
		}

		const operation = import("./credits.js").then(({ createCreditStatusRuntime }) => {
			const runtime = createCreditStatusRuntime(notifier.warn);
			if (creditStatusState.kind === "disposed") {
				runtime.dispose();
				return runtime;
			}
			creditStatusState = { kind: "ready", runtime };
			return runtime;
		});
		creditStatusState = { kind: "loading", operation };
		void operation.catch(() => {
			if (creditStatusState.kind === "loading" && creditStatusState.operation === operation) {
				creditStatusState = { kind: "idle" };
			}
		});
		return operation;
	}

	function schedulePendingCreditStatusRefresh(): void {
		if (!pendingCreditStatusRefresh || creditStatusRefreshWork !== undefined) return;

		// Jiti evaluates transformed modules synchronously once import starts. A
		// macrotask lets Pi finish its awaited lifecycle dispatch before that work.
		const scheduled = setImmediate(() => {
			void loadCreditStatus()
				.then((runtime) => {
					if (creditStatusRefreshWork !== scheduled) return;
					const refresh = pendingCreditStatusRefresh;
					pendingCreditStatusRefresh = undefined;
					creditStatusRefreshWork = undefined;
					if (refresh) {
						void runtime.refresh(refresh.ctx, refresh.model).catch((error: unknown) => {
							if (creditStatusState.kind !== "disposed") {
								notifier.warn(`Unable to refresh Hyper status: ${String(error)}`);
							}
						});
					}
				})
				.catch((error: unknown) => {
					if (creditStatusRefreshWork === scheduled && creditStatusState.kind !== "disposed") {
						pendingCreditStatusRefresh = undefined;
						notifier.warn(`Unable to load Hyper status support: ${String(error)}`);
					}
				})
				.finally(() => {
					if (creditStatusRefreshWork !== scheduled) return;
					creditStatusRefreshWork = undefined;
					schedulePendingCreditStatusRefresh();
				});
		});
		creditStatusRefreshWork = scheduled;
	}

	function scheduleCreditStatusRefresh(ctx: ExtensionContext, model: ExtensionContext["model"]): void {
		pendingCreditStatusRefresh = { ctx, model };
		schedulePendingCreditStatusRefresh();
	}

	function deactivateCreditStatus(ctx: ExtensionContext, model: ExtensionContext["model"]): void {
		pendingCreditStatusRefresh = undefined;
		if (creditStatusRefreshWork !== undefined) {
			clearImmediate(creditStatusRefreshWork);
			creditStatusRefreshWork = undefined;
		}
		if (creditStatusState.kind === "ready") {
			void creditStatusState.runtime.refresh(ctx, model);
		}
		ctx.ui.setStatus(PROVIDER_NAME, undefined);
	}

	pi.on("session_start", (_event, ctx) => {
		notifier.activate(ctx);
		if (ctx.sessionManager) {
			tracker.syncSessionFromEntries(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
		}
		if (ctx.hasUI && typeof ctx.ui.addAutocompleteProvider === "function") {
			ctx.ui.addAutocompleteProvider((current) => createHyperAutocompleteProvider(current));
		}
		if (!ctx.hasUI) return;
		if (ctx.model?.provider !== PROVIDER_NAME) {
			deactivateCreditStatus(ctx, ctx.model);
			return;
		}
		scheduleCreditStatusRefresh(ctx, ctx.model);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (ctx.sessionManager) {
			tracker.syncSessionFromEntries(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		if (ctx.sessionManager) {
			tracker.syncSessionFromEntries(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
		}
	});

	const baseApi = openAICompletionsApi();

	const hyperApi: ProviderStreams = {
		stream(model, context, options) {
			const userOnPayload = options?.onPayload;
			const userOnResponse = options?.onResponse;
			const wrappedOptions: StreamOptions = {
				...options,
				onPayload: async (payload, m) => {
					let p = payload;
					if (userOnPayload) {
						p = (await userOnPayload(p, m)) ?? p;
					}
					return optimizeHyperPayload(p as unknown as HyperChatPayload);
				},
				onResponse: async (response, m) => {
					tracker.updateServerRateLimits(response.headers);
					await userOnResponse?.(response, m);
				},
			};
			return baseApi.stream(model, context, wrappedOptions);
		},
		streamSimple(model, context, options) {
			const userOnPayload = options?.onPayload;
			const userOnResponse = options?.onResponse;
			const wrappedOptions: SimpleStreamOptions = {
				...options,
				onPayload: async (payload, m) => {
					let p = payload;
					if (userOnPayload) {
						p = (await userOnPayload(p, m)) ?? p;
					}
					return optimizeHyperPayload(p as unknown as HyperChatPayload);
				},
				onResponse: async (response, m) => {
					tracker.updateServerRateLimits(response.headers);
					await userOnResponse?.(response, m);
				},
			};
			return baseApi.streamSimple(model, context, wrappedOptions);
		},
	};

	pi.registerProvider(
		createProvider({
			id: PROVIDER_NAME,
			name: PROVIDER_DISPLAY_NAME,
			baseUrl: HYPER_API_BASE_URL,
			auth: {
				apiKey: envApiKeyAuth("Hyper API key", ["HYPER_API_KEY"]),
				oauth: lazyOAuth({
					name: PROVIDER_DISPLAY_NAME,
					load: async () => {
						const { loginHyper, refreshHyperToken } = await import("./oauth.js");
						return {
							name: PROVIDER_DISPLAY_NAME,
							login: loginHyper,
							refresh: refreshHyperToken,
							toAuth: async (credential) => ({ apiKey: credential.access }),
						} satisfies OAuthAuth;
					},
				}),
			},
			models: [],
			fetchModels: async ({ credential, signal }) => {
				const token = credential?.type === "oauth" ? credential.access : credential?.key;
				return fetchHyperModels({ signal, token });
			},
			api: hyperApi,
		}),
	);

	pi.registerCommand("hyper", {
		description: "Charm Hyper dashboard, credits, requests, and stats",
		getArgumentCompletions: (argumentPrefix: string) => {
			return getHyperArgumentCompletions(argumentPrefix);
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const tokens = trimmed.split(/\s+/).filter(Boolean);
			const subcommand = tokens[0]?.toLowerCase() ?? "";

			if (ctx.sessionManager) {
				tracker.syncSessionFromEntries(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
			}

			try {
				const runtime = await loadCreditStatus();
				if (creditStatusState.kind === "disposed") return;

				if (subcommand === "credits") {
					if (runtime.getBalance() === undefined && ctx.model?.provider === PROVIDER_NAME) {
						await runtime.refresh(ctx, ctx.model, true);
					}
					const msg = renderCreditsMessage(runtime.getBalance(), runtime.getLastRefreshedAt(), runtime.getLastError());
					ctx.ui.notify(msg, "info");
					return;
				}

				if (subcommand === "requests") {
					const summary = tracker.getSummary();
					const msg = renderRequestsMessage(summary);
					ctx.ui.notify(msg, "info");
					return;
				}

				if (subcommand === "stats") {
					const summary = tracker.getSummary();
					const msg = renderStatsMessage(summary);
					ctx.ui.notify(msg, "info");
					return;
				}

				if (subcommand === "refresh") {
					await runtime.refresh(ctx, ctx.model, true);

					// Refresh models catalog if auth available
					try {
						const activeModel = ctx.model ?? {
							id: "default",
							provider: PROVIDER_NAME,
							api: "openai-completions" as const,
							baseUrl: HYPER_API_BASE_URL,
							name: "Default",
							reasoning: false,
							input: ["text" as const],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 1000,
						};
						const auth = await ctx.modelRegistry.getApiKeyAndHeaders(activeModel);
						if (auth.ok && auth.apiKey) {
							const ctrl = new AbortController();
							await fetchHyperModels({ token: auth.apiKey, signal: ctrl.signal });
						}
					} catch {
						// Non-fatal if model refresh fails
					}

					const balance = runtime.getBalance();
					const balancePart = balance !== undefined ? ` Balance: ${formatCredits(balance)} HC` : "";
					ctx.ui.notify(`Hyper refreshed successfully.${balancePart}`, "info");
					return;
				}

				if (subcommand === "status") {
					const subArgs = tokens.slice(1).join(" ");
					await runtime.handleCommand(subArgs, ctx);
					return;
				}

				if (subcommand === "help") {
					ctx.ui.notify(renderHelpMessage(), "info");
					return;
				}

				if (subcommand !== "") {
					ctx.ui.notify(
						`Unknown subcommand '${subcommand}'. Usage: /hyper [credits | requests | stats | refresh | status | help]`,
						"warning",
					);
					return;
				}

				// Default dashboard view: /hyper
				if (runtime.getBalance() === undefined && ctx.model?.provider === PROVIDER_NAME) {
					await runtime.refresh(ctx, ctx.model, true);
				}

				const summary = tracker.getSummary();
				const activeModel = ctx.model?.provider === PROVIDER_NAME ? ctx.model : undefined;
				const rawModel = activeModel ? getCachedRawModel(activeModel.id) : undefined;

				const dashboardBox = renderDashboardBox({
					balance: runtime.getBalance(),
					lastRefreshedAt: runtime.getLastRefreshedAt(),
					error: runtime.getLastError(),
					tracking: summary,
					activeModel,
					rawModel,
				});

				ctx.ui.notify(dashboardBox, "info");
			} catch (error) {
				if (creditStatusState.kind === "disposed") return;
				ctx.ui.notify(`Hyper error: ${String(error)}`, "warning");
			}
		},
	});

	pi.registerCommand("hyper-status", {
		description: "Configure the Charm Hyper footer status (legacy alias)",
		getArgumentCompletions: (argumentPrefix: string) => {
			return getHyperStatusArgumentCompletions(argumentPrefix);
		},
		handler: async (args, ctx) => {
			try {
				const runtime = await loadCreditStatus();
				if (creditStatusState.kind === "disposed") return;
				await runtime.handleCommand(args, ctx);
			} catch (error) {
				if (creditStatusState.kind === "disposed") return;
				ctx.ui.notify(`Unable to load Hyper status support: ${String(error)}`, "warning");
			}
		},
	});

	pi.on("model_select", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.model.provider !== PROVIDER_NAME) {
			deactivateCreditStatus(ctx, event.model);
			return;
		}
		scheduleCreditStatusRefresh(ctx, event.model);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_NAME) return;
		if (event.payload && typeof event.payload === "object") {
			return optimizeHyperPayload(event.payload as unknown as HyperChatPayload);
		}
	});

	pi.on("after_provider_response", (event, _ctx) => {
		if (event.headers) {
			tracker.updateServerRateLimits(event.headers);
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || event.message.provider !== PROVIDER_NAME) return;

		const usage = event.message.usage;
		tracker.recordRequest({
			sessionId: ctx.sessionManager?.getSessionId(),
			model: event.message.responseModel ?? event.message.model,
			usage: usage
				? {
						inputTokens: usage.input,
						cachedTokens: usage.cacheRead,
						cacheWriteTokens: usage.cacheWrite,
						outputTokens: usage.output,
						reasoningTokens: usage.reasoning,
						actualCostUsd: usage.cost?.total,
						actualCostHc: usage.cost?.total !== undefined ? usage.cost.total * HYPERCREDITS_PER_USD : undefined,
					}
				: undefined,
			timestamp: event.message.timestamp ?? Date.now(),
		});

		if (ctx.hasUI && ctx.model?.provider === PROVIDER_NAME) {
			scheduleCreditStatusRefresh(ctx, ctx.model);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (creditStatusState.kind === "disposed" || !ctx.hasUI || ctx.model?.provider !== PROVIDER_NAME) return;
		scheduleCreditStatusRefresh(ctx, ctx.model);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		tracker.resetSession();
		pendingCreditStatusRefresh = undefined;
		if (creditStatusRefreshWork !== undefined) clearImmediate(creditStatusRefreshWork);
		creditStatusRefreshWork = undefined;
		if (creditStatusState.kind === "ready") creditStatusState.runtime.dispose();
		creditStatusState = { kind: "disposed" };
		if (ctx.hasUI) ctx.ui.setStatus(PROVIDER_NAME, undefined);
	});
}
