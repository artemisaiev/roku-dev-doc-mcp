import test from 'node:test';
import assert from 'node:assert/strict';

import { gitBlobSha, parseDoc, parseFrontmatter } from '../src/sync.js';
import {
  buildToc,
  clamp,
  findSectionFor,
  selectSection,
  slugify,
  splitSections,
} from '../src/sections.js';
import { sanitizeQuery } from '../src/db.js';

/* ------------------------------------------------------------- blob sha */

test('gitBlobSha matches git hash-object', () => {
  // `printf 'hello' | git hash-object --stdin`
  assert.equal(
    gitBlobSha(Buffer.from('hello')),
    'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0'
  );
  // `git hash-object` of an empty file
  assert.equal(
    gitBlobSha(Buffer.from('')),
    'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
  );
});

/* --------------------------------------------------------- frontmatter */

test('parseFrontmatter splits YAML from body', () => {
  const { data, body } = parseFrontmatter('---\ntitle: Hello\nhidden: false\n---\nBody text\n');
  assert.equal(data.title, 'Hello');
  assert.equal(data.hidden, false);
  assert.equal(body.trim(), 'Body text');
});

test('parseFrontmatter handles a frontmatter-only file with no trailing newline', () => {
  const { data, body } = parseFrontmatter("---\ntitle: Stub\nexcerpt: ''\n---");
  assert.equal(data.title, 'Stub');
  assert.equal(body.trim(), '');
});

test('parseFrontmatter leaves body untouched when there is no frontmatter', () => {
  const { data, body } = parseFrontmatter('# Just a heading\n\ntext');
  assert.deepEqual(data, {});
  assert.equal(body, '# Just a heading\n\ntext');
});

test('parseFrontmatter survives malformed YAML without losing the body', () => {
  const { data, body } = parseFrontmatter('---\ntitle: "unterminated\n  bad: [\n---\nReal body\n');
  assert.deepEqual(data, {});
  assert.match(body, /Real body/);
});

test('parseFrontmatter does not treat a horizontal rule as frontmatter', () => {
  const { data, body } = parseFrontmatter('---\n\nnot yaml, just an hr\n');
  assert.deepEqual(data, {});
  assert.match(body, /just an hr/);
});

/* -------------------------------------------------------------- parseDoc */

test('parseDoc prefers the frontmatter title and strips frontmatter from content', () => {
  const raw = "---\ntitle: 'roArray'\nexcerpt: An array component\n---\nAn array stores things.\n";
  const doc = parseDoc('docs/REFERENCES/roarray.md', raw);
  assert.equal(doc.title, 'roArray');
  assert.equal(doc.excerpt, 'An array component');
  assert.equal(doc.content, 'An array stores things.');
  assert.ok(!doc.content.includes('---'));
});

test('parseDoc falls back to the first heading, then the filename', () => {
  assert.equal(parseDoc('docs/a/b.md', '# Heading Title\n\nbody').title, 'Heading Title');
  assert.equal(parseDoc('docs/a/some-page.md', 'no heading at all').title, 'Some Page');
  assert.equal(parseDoc('docs/a/scenegraph/index.md', 'body only').title, 'Scenegraph');
});

test('parseDoc falls back to metadata.description then first paragraph for excerpt', () => {
  const withMeta = parseDoc(
    'docs/a.md',
    '---\ntitle: T\nmetadata:\n  description: From metadata\n---\nBody paragraph.\n'
  );
  assert.equal(withMeta.excerpt, 'From metadata');

  const derived = parseDoc('docs/a.md', '---\ntitle: T\n---\n# Head\n\nThe first real paragraph here.\n');
  assert.equal(derived.excerpt, 'The first real paragraph here.');
});

/* -------------------------------------------------------------- sections */

test('splitSections ignores headings inside fenced code blocks', () => {
  const md = [
    '# Real',
    'text',
    '```brightscript',
    '# a comment, not a heading',
    '## also not',
    '```',
    '## Second',
    '~~~',
    '### tilde-fenced',
    '~~~',
  ].join('\n');
  const titles = splitSections(md).map((s) => s.title);
  assert.deepEqual(titles, ['Real', 'Second']);
});

test('splitSections captures preamble before the first heading', () => {
  const s = splitSections('Intro prose.\n\n# First\n\nbody');
  assert.equal(s[0].title, '(intro)');
  assert.match(s[0].content, /Intro prose/);
  assert.equal(s[1].title, 'First');
});

test('splitSections returns one pseudo-section for heading-less content', () => {
  const s = splitSections('just some text with no headings');
  assert.equal(s.length, 1);
  assert.equal(s[0].title, '(document)');
});

test('splitSections returns nothing for empty content', () => {
  assert.deepEqual(splitSections(''), []);
  assert.deepEqual(splitSections('   \n  '), []);
});

test('section indexes are 1-based and contiguous', () => {
  const s = splitSections('# A\nx\n## B\ny\n### C\nz');
  assert.deepEqual(s.map((x) => x.index), [1, 2, 3]);
  assert.deepEqual(s.map((x) => x.level), [1, 2, 3]);
});

test('selectSection resolves by number, exact title, slug and substring', () => {
  const s = splitSections('# Audio Requirements\nx\n## Video Frame Rate\ny');
  assert.equal(selectSection(s, 1).title, 'Audio Requirements');
  assert.equal(selectSection(s, '2').title, 'Video Frame Rate');
  assert.equal(selectSection(s, 'Audio Requirements').title, 'Audio Requirements');
  assert.equal(selectSection(s, 'video-frame-rate').title, 'Video Frame Rate');
  assert.equal(selectSection(s, 'frame').title, 'Video Frame Rate');
  assert.equal(selectSection(s, 'nothing here'), undefined);
  assert.equal(selectSection(s, ''), undefined);
});

test('findSectionFor points at the section containing the terms', () => {
  const s = splitSections('# Intro\nnothing\n## Closed Captions\nsubtitle rules\n## Audio\nloudness');
  assert.equal(s[findSectionFor(s, 'closed captions') - 1].title, 'Closed Captions');
  assert.equal(s[findSectionFor(s, 'loudness') - 1].title, 'Audio');
});

test('buildToc renders a numbered outline indented by heading level', () => {
  const [top, nested] = buildToc(splitSections('# A\nx\n## B\ny')).split('\n');
  assert.match(top, /^\s*1\. A\b/);
  assert.match(nested, /^\s*2\. \s+B\b/);
  // the level-2 entry sits further right than the level-1 entry
  assert.ok(nested.indexOf('B') > top.indexOf('A'));
});

test('clamp truncates on a line boundary and reports it', () => {
  const short = clamp('abc', 100);
  assert.equal(short.truncated, false);
  assert.equal(short.text, 'abc');

  const long = clamp(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'), 200);
  assert.equal(long.truncated, true);
  assert.ok(Buffer.byteLength(long.text) <= 200);
  assert.ok(!long.text.endsWith('\n'));
});

test('slugify lowercases, drops punctuation and collapses whitespace runs', () => {
  assert.equal(slugify('Closed captions and subtitles'), 'closed-captions-and-subtitles');
  // punctuation is dropped and the resulting whitespace run collapses to one
  // hyphen, which makes user-supplied section text easier to match
  assert.equal(slugify('External branding & CTAs (extra)'), 'external-branding-ctas-extra');
  assert.equal(slugify('  Padded   Title  '), 'padded-title');
});

/* ---------------------------------------------------------- query safety */

test('sanitizeQuery quotes tokens and drops bare FTS5 operators', () => {
  assert.equal(sanitizeQuery('roArray Push'), '"roArray" AND "Push"');
  assert.equal(sanitizeQuery('roArray AND'), '"roArray"');
  assert.equal(sanitizeQuery('"unbalanced'), '"unbalanced"');
  assert.equal(sanitizeQuery('a AND (b'), '"a" AND "b"');
  assert.equal(sanitizeQuery('video*'), '"video"*');
  assert.equal(sanitizeQuery(''), '');
  assert.equal(sanitizeQuery('   '), '');
});
