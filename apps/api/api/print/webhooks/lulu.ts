import { Hono } from 'hono';
import { CookbookPrintService } from '@/utils/cookbookPrintService';

const route = new Hono();
const service = new CookbookPrintService();

route.post('/', async c => {
  const rawBody = await c.req.text();
  try {
    await service.handleLuluWebhook(rawBody, c.req.header('lulu-hmac-sha256') || null);
    return c.json({ received: true });
  } catch (error: any) {
    console.error('Lulu webhook failed:', error?.code || error?.name || 'ERROR');
    return c.json({ error: 'webhook_failed' }, error?.status === 503 ? 503 : 400);
  }
});

export default route;
