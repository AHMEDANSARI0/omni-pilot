import type { Services } from './services';
import type { WebhookDispatcher } from './omni';

/**
 * Adapts the app's Database port onto the small dispatcher interface the webhook code needs.
 *
 * Kept as an adapter rather than widening `Database` further: the delivery logic is testable with a
 * five-method stub, and the rest of the app never has to know webhooks exist.
 */
export function webhookDispatcherFor(services: Services): WebhookDispatcher {
  return {
    listActiveEndpoints: () => services.db.listWebhookEndpoints({ activeOnly: true }),
    enqueue: (input) => services.db.enqueueWebhookDelivery(input),
    claimDue: (limit) => services.db.claimWebhookDeliveries(limit),
    finish: (id, patch) => services.db.updateWebhookDelivery(id, patch),
    markEndpointResult: async (endpointId, result) => {
      if (result.ok) {
        await services.db.updateWebhookEndpoint(endpointId, {
          lastSuccessAt: result.at,
          lastError: null,
          failureCount: 0,
        });
        return;
      }
      const endpoints = await services.db.listWebhookEndpoints();
      const current = endpoints.find((endpoint) => endpoint.id === endpointId);
      await services.db.updateWebhookEndpoint(endpointId, {
        lastFailureAt: result.at,
        lastError: result.error,
        // After five consecutive failures the endpoint is switched off: a dead URL should stop costing
        // the owner delivery attempts, and the dashboard shows why.
        failureCount: (current?.failureCount ?? 0) + 1,
        ...((current?.failureCount ?? 0) + 1 >= 5 ? { active: false } : {}),
      });
    },
  };
}
