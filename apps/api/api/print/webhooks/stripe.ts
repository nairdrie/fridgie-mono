import { Hono } from 'hono';
import { CookbookPrintService } from '@/utils/cookbookPrintService';

const route = new Hono();
const service = new CookbookPrintService();

route.post('/', async c => {
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ error: 'missing_signature' }, 400);
  // Signature verification must receive the untouched bytes. Do not call
  // c.req.json() before this.
  const rawBody = await c.req.text();
  try {
    await service.handleStripeWebhook(rawBody, signature);
    return c.json({ received: true });
  } catch (error: any) {
    console.error('Stripe webhook failed:', error?.code || error?.name || 'ERROR');
    return c.json({ error: 'webhook_failed' }, error?.code === 'PRINT_NOT_CONFIGURED' ? 503 : 400);
  }
});

export default route;
