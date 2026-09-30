import { CookbookPrintService } from '@/utils/cookbookPrintService';
import { CookbookPrintStore } from '@/utils/cookbookPrintStore';
import { cleanupExpiredPrintArtifacts } from '@/utils/cookbookPrintStorage';

export async function runPrintReconciliation(options: {
  store?: CookbookPrintStore;
  service?: CookbookPrintService;
  limit?: number;
} = {}) {
  const store = options.store ?? new CookbookPrintStore();
  const service = options.service ?? new CookbookPrintService();
  const orders = await store.listOrdersForReconciliation(options.limit ?? 100);
  const results = await Promise.allSettled(orders.map(async order => {
    try {
      await service.reconcileOrder(order.id);
    } finally {
      // Persist a fair round-robin cursor even for a temporarily failing order,
      // so one old provider job cannot starve newly authorized work forever.
      await store.markReconciled(order.id);
    }
  }));
  const artifactsDeleted = await cleanupExpiredPrintArtifacts().catch(() => 0);
  const failed = results.filter(result => result.status === 'rejected').length;
  return { examined: orders.length, reconciled: orders.length - failed, failed, artifactsDeleted };
}

if (import.meta.main) {
  const result = await runPrintReconciliation();
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
}
