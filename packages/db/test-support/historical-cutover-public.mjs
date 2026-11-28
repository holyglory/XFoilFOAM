import { buildServer } from '../../../apps/api/src/server.ts';
import { closeDatabasePools } from '../../../apps/api/src/db.ts';
const [slug, resultId, attemptId] = process.argv.slice(2);
const app = await buildServer();
try {
  const sim = await app.inject({ method: 'GET', url: `/api/airfoils/${encodeURIComponent(slug)}/sim?resultId=${resultId}&resultAttemptId=${attemptId}` });
  if (sim.statusCode !== 200) throw new Error(`Historical public result unavailable: ${sim.statusCode} ${sim.body}`);
  const body = sim.json();
  process.stdout.write(JSON.stringify({ status: sim.statusCode, cl: body.cl, cd: body.cd, fidelity: body.fidelity }));
} finally {
  await app.close();
  await closeDatabasePools();
}
