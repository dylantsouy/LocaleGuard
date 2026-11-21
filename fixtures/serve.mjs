import { createFixtureServer } from './site.mjs';

const port = Number(process.env.PORT ?? 4173);
const server = createFixtureServer();
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Fixture listening on http://127.0.0.1:${server.address().port}/en/catalog`);
});
