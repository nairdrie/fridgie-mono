import { expect, test } from 'bun:test';

/** Run the real entrypoint with offline modules and an intentionally open handle. */
async function runJob(fail: boolean) {
  const generatorPath = `${import.meta.dir}/../utils/curatedGenerator.ts`;
  const discoveryPath = `${import.meta.dir}/../utils/discovery.ts`;
  const entrypoint = `${import.meta.dir}/../jobs/discovery.ts`;
  const source = `
    import { mock } from 'bun:test';
    mock.module(${JSON.stringify(generatorPath)}, () => ({ CURATED_CREATORS: [], generateCuratedRecipe: async () => ({}) }));
    mock.module(${JSON.stringify(discoveryPath)}, () => ({ runDiscoveryTick: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      console.info('MOCK_WORK_SETTLED');
      if (${fail}) throw new Error('DO_NOT_LOG_PROVIDER_DETAILS');
      return { status: 'not-due' };
    } }));
    setInterval(() => {}, 1000);
    await import(${JSON.stringify(entrypoint)});
  `;
  const child = Bun.spawn([process.execPath, '--eval', source], { stdout: 'pipe', stderr: 'pipe' });
  const watchdog = setTimeout(() => child.kill(), 3000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally { clearTimeout(watchdog); }
}

test('job exits zero after awaited success despite open runtime handles', async () => {
  const result = await runJob(false);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('MOCK_WORK_SETTLED');
  expect(result.stdout).toContain('Discover generation finished');
});

test('job exits nonzero after awaited failure without logging provider details', async () => {
  const result = await runJob(true);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('MOCK_WORK_SETTLED');
  expect(result.stderr).toContain('Discover generation failed');
  expect(result.stderr).not.toContain('DO_NOT_LOG_PROVIDER_DETAILS');
});
