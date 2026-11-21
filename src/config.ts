import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Config, Viewport } from './types.js';

function object(value: unknown, path: string, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  if (keys) {
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) throw new Error(`Unknown field ${path}.${key}`);
    }
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${path} must be a non-empty array`);
  return value;
}

function label(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${path} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function checkNames(items: { name: string }[], path: string) {
  if (new Set(items.map(item => item.name)).size !== items.length) {
    throw new Error(`${path} names must be unique`);
  }
}

export function validateConfig(raw: unknown, directory: string): Config {
  const cfg = object(raw, 'config', ['pages', 'viewports', 'outputDir', 'concurrency', 'timeoutMs']);
  const pages = list(cfg.pages, 'pages').map((value, i) => {
    const path = `pages[${i}]`;
    const page = object(value, path, ['name', 'baseline', 'locales']);
    const entries = Object.entries(object(page.locales, `${path}.locales`));
    for (const [lang] of entries) {
      try {
        Intl.getCanonicalLocales(lang);
      } catch {
        throw new Error(`${path}.locales contains an invalid language tag: ${lang}`);
      }
    }
    const locales = Object.fromEntries(entries.map(([lang, value]) => {
      const url = new URL(label(value, `${path}.locales.${lang}`));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${path}.locales.${lang} requires an HTTP(S) URL without credentials`);
      }
      return [lang, url.href];
    })) as Record<string, string>;
    const baseline = label(page.baseline, `${path}.baseline`);
    if (!Object.hasOwn(locales, baseline)) throw new Error(`${path}.baseline must appear in locales`);
    return { name: label(page.name, `${path}.name`), baseline, locales };
  });
  const viewports: Viewport[] = list(cfg.viewports, 'viewports').map((value, i) => {
    const path = `viewports[${i}]`;
    const vp = object(value, path, ['name', 'width', 'height']);
    return {
      name: label(vp.name, `${path}.name`),
      width: integer(vp.width, `${path}.width`, 1, 4096),
      height: integer(vp.height, `${path}.height`, 1, 4096),
    };
  });
  checkNames(pages, 'pages');
  checkNames(viewports, 'viewports');
  const targets = pages.reduce((n, page) => n + Object.keys(page.locales).length * viewports.length, 0);
  if (targets > 500) throw new Error('Config exceeds the limit of 500 scan targets');
  return {
    pages, viewports,
    outputDir: resolve(directory, label(cfg.outputDir === undefined ? 'localeguard-reports' : cfg.outputDir, 'outputDir')),
    concurrency: integer(cfg.concurrency === undefined ? 2 : cfg.concurrency, 'concurrency', 1, 8),
    timeoutMs: integer(cfg.timeoutMs === undefined ? 30000 : cfg.timeoutMs, 'timeoutMs', 1000, 120000),
  };
}

export async function loadConfig(file: string): Promise<Config> {
  const path = resolve(file);
  try {
    const json = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
    return validateConfig(JSON.parse(json), dirname(path));
  } catch (error) {
    throw new Error(`Cannot load config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
