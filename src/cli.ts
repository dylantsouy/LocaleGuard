#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { scan, exitCode } from './scan.js';

const program = new Command()
  .name('localeguard')
  .description('Scan localized web pages for layout problems')
  .exitOverride();
program.command('scan')
  .description('Scan the page, language and viewport combinations in a JSON config')
  .option('-c, --config <file>', 'path to JSON configuration', 'localeguard.config.json')
  .action(async ({ config }: { config: string }) => {
    const { directory, report } = await scan(await loadConfig(config));
    for (const target of report.results) {
      if (target.scanStatus !== 'completed') {
        console.error('%s', JSON.stringify({ page: target.page, language: target.language, viewport: target.viewport.name,
          scanStatus:target.scanStatus, error: target.error, diagnostics:target.coverage?.diagnostics }));
      }
    }
    const issues = report.results.flatMap(target => target.issues);
    const errors = issues.filter(issue => issue.severity === 'error').length;
    const failed = report.results.filter(target => target.status === 'failed').length;
    const partial = report.results.filter(t=>t.scanStatus==='partial').length;
    console.log(`${report.results.length} targets, ${errors} errors, ${issues.length - errors} warnings, ${failed} failed scans, ${partial} partial`);
    console.log(`HTML  ${join(directory, 'index.html')}\nJSON  ${join(directory, 'report.json')}`);
    process.exitCode = exitCode(report);
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    console.error('LocaleGuard:', error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
