import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { requireAccount } from '@/middleware/requireAccount';
import { getAccountStatus } from '@/utils/aiQuota';

const route = new Hono();

route.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  return await next();
});
route.use('*', auth, requireAccount);

const loadStatus = async (uid: string, forceRefresh: boolean) =>
  getAccountStatus(uid, { forceRefresh });

route.get('/', async (c) => {
  try {
    return c.json(await loadStatus(c.get('uid'), false));
  } catch (error) {
    console.error('Failed to load account status:', error instanceof Error ? error.name : 'unknown');
    return c.json({ error: 'account_status_unavailable', message: 'Account status is temporarily unavailable.' }, 503);
  }
});

/** Call after purchase or restore; identity always comes from the Firebase token. */
route.post('/refresh', async (c) => {
  try {
    return c.json(await loadStatus(c.get('uid'), true));
  } catch (error) {
    console.error('Failed to refresh account status:', error instanceof Error ? error.name : 'unknown');
    return c.json({ error: 'account_status_unavailable', message: 'Account status is temporarily unavailable.' }, 503);
  }
});

export default route;
