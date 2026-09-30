import { CookbookPrintService } from '@/utils/cookbookPrintService';

const orderId = process.argv[2];

if (!orderId || !/^order_[a-f0-9]{28}$/.test(orderId)) {
  console.error('Usage: bun jobs/submitApprovedReprint.ts order_<28 lowercase hex characters>');
  process.exitCode = 2;
} else {
  await new CookbookPrintService().submitApprovedReprint(orderId);
  console.log(JSON.stringify({ orderId, submitted: true }));
}
