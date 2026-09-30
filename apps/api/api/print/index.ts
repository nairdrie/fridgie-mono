import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { requireAccount } from '@/middleware/requireAccount';
import { CookbookPrintError, CookbookPrintService, publicPrintDraft } from '@/utils/cookbookPrintService';

const route = new Hono();
const service = new CookbookPrintService();

route.use('*', auth, requireAccount);

route.onError((error: any, c) => {
  console.error('Cookbook print request failed:', error?.code || error?.name || 'ERROR');
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  const known = error instanceof CookbookPrintError || typeof error?.code === 'string';
  return c.json({
    error: known ? error.code : 'PRINT_REQUEST_FAILED',
    message: known ? error.message : 'The print request could not be completed.',
    ...(error?.extra && typeof error.extra === 'object' ? error.extra : {}),
  }, status as any);
});

route.get('/eligibility', async c => c.json(await service.eligibility(c.get('uid'))));

route.get('/draft', async c => c.json(publicPrintDraft(await service.getOrCreateDraft(c.get('uid')))));
route.post('/draft', async c => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(publicPrintDraft(await service.getOrCreateDraft(c.get('uid'), body)), 201);
});
route.get('/draft/:id', async c => c.json(publicPrintDraft(await service.getDraft(c.get('uid'), c.req.param('id')))));
route.put('/draft/:id', async c => {
  const body = await c.req.json<Record<string, unknown>>();
  const revision = Number(body.revision);
  return c.json(publicPrintDraft(await service.updateDraft(c.get('uid'), c.req.param('id'), revision, body.draft ?? body)));
});
route.post('/draft/:id/preview', async c => c.json(await service.preview(c.get('uid'), c.req.param('id'))));
route.post('/draft/:id/quote', async c => {
  const body = await c.req.json<{ address?: unknown }>();
  return c.json(await service.quote(c.get('uid'), c.req.param('id'), body.address));
});
route.post('/draft/:id/checkout', async c => {
  const body = await c.req.json<any>();
  return c.json(await service.checkout(c.get('uid'), c.req.param('id'), body));
});

route.get('/orders', async c => c.json(await service.listOrders(c.get('uid'))));
route.post('/orders/:id/retry', async c => c.json(await service.retrySubmission(c.get('uid'), c.req.param('id'))));
route.post('/orders/:id/cancel', async c => c.json(await service.cancelOrder(c.get('uid'), c.req.param('id'))));
route.post('/orders/:id/reprint', async c => c.json(await service.requestReprint(c.get('uid'), c.req.param('id'))));
route.get('/orders/:id', async c => c.json(await service.getOrder(c.get('uid'), c.req.param('id'))));

export default route;
