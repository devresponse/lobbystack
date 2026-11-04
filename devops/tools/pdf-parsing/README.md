# Test PDF readers

A command-line tool that reads a folder of PDFs with the worker's original reader or with pdfjs-dist, writes each document's text and chunks to a folder of its own, scores them, and can upload a reader's text to a test business so the receptionist's knowledge search can be checked against it.

It is a test tool only. It changes nothing in `apps/` or `packages/` and imports nothing from them: the worker's reader and `chunkText` are copied in byte for byte, and a check fails when the copies drift. Since fork PR #137 the worker reads PDFs with its improved reader, whose layout is the `pdfjs` reader's, so `current` shows how PDFs were read before, and how they're read with `KNOWLEDGE_PDF_READER=original`. It is its own npm package, outside the pnpm workspace, so its dependencies never touch the workspace's lockfile.

## Set it up

It needs Node 26, like the rest of the repository.

```bash
cd devops/tools/pdf-parsing
npm ci
```

Every command runs as `node src/cli.ts <command>`, or `npm run pdf-parsing -- <command>`. `node src/cli.ts help` lists the options.

## Read a folder of PDFs

```bash
node src/cli.ts parse --input ~/strata-pdfs --output out --parser all
```

On Windows:

```powershell
node src\cli.ts parse --input C:\strata-pdfs --output out --parser all
```

`--parser` takes `current` (the default), `pdfjs`, a comma-separated list or `all`. `--recursive` also reads subfolders. Each PDF gets its own folder, and each reader a folder inside it:

```text
out/
  summary.md, summary.csv, summary.json   every document and reader in one table
  budget/
    compare.md                             the readers side by side, and the numbers they disagree on
    current/
      text.md                              exactly what the reader returned: what the worker hands to chunkText
      chunks.md, chunks.json               what chunkText makes of it: the chunks the receptionist's search can hand over
      result.json                          timings, OCR, the metrics and the score
    pdfjs/
      ...                                  the same, plus pages.json with each page's text
```

Running `parse` again with another reader into the same output folder adds its results, and the summaries then cover both.

## Know the readers

**current** is the worker's original reader, `extractPdfTextDefault` in `apps/worker/src/documentExtraction.ts`, copied byte for byte to `src/parsers/current/documentExtraction.ts`, with the same pdf-parse 2.4.5, pdfjs-dist 6.4.299, tesseract.js 7.0.0 and mammoth 1.13.0 the worker's lockfile resolves. The tool calls `extractDocumentTextInThread` as the worker's `knowledge.extractDocument` job does, with `KNOWLEDGE_PDF_READER=original`: in its own thread, with a 512 MB heap cap and a 5-minute deadline (`--max-heap-mb`, `--timeout-ms`). So it shows the original reader's failures as they happened in production: footnote marks fused into amounts (`$25,0002`), no page numbers, and a scan of more than 10 pages refused.

**pdfjs** reads pdfjs-dist 6.4's text items, which carry each piece of text's position and font size, and applies the repairs the design proposes, with no AI. The worker's improved reader, `extractPdfTextImproved` (fork PR #137), lays text out the same way, with `[Page 2 of 9]` markers, and gave the same text on every fixture; it reads 10 pages at most by OCR and refuses a scan of more than 10 pages, as the original does:

- Cells split by a gap wider than 7 units (where pdf-parse puts its tab) are written with ` | `, which chunkText keeps, while it turns tabs into spaces.
- A small mark raised above the text beside it becomes a footnote: `$25,000 [^2]`, and `[^2]: Per claim.` where the footnote itself starts.
- A row's values stay on its label's first line when the label wraps onto a second line.
- Each page starts with `[Page 2 of 9]`, or `## Page 2 of 9` with `--page-markers heading`, which also makes chunkText start a chunk at every page. `--page-markers none` leaves them out. `chunks.json` lists the pages each chunk covers.
- Every page without a text layer is read by OCR, with the worker's languages (English and French) and render scale, up to `--ocr-max-pages` pages (50 by default), and its words go through the same cell rule. Today's reader only reads by OCR when no page has text.

Text is laid out in the order the PDF draws it, so a two-column page keeps its columns apart, as pdf-parse does.

pdfjs-dist is pinned at 6.4.299. Version 6.5 came out on 1 November 2026, inside the 3 days the workspace waits before it takes a release (`minimumReleaseAge`), so it can replace 6.4 in a later change.

To try another reader, add a `Parser` (`src/parsers/types.ts`) and list it in `src/parsers/index.ts`; `--parser` then takes its name.

## Read the results

`summary.md` has a row per document and reader. The counts come from the stored text, the text after chunkText has turned tabs and runs of spaces into one space, because that's what the receptionist gets.

| Column | What it counts |
| --- | --- |
| `numbers` | Numbers in the stored text, read the way the design's number checks read them: `$412,800` and `412 800 $` are both 412800, `(1,250)` is -1250, `7,0 %` is 7.0% |
| `impossible_numbers` | Digit groups no real number has, such as `$25,0002` or `10%4`: a footnote mark fused into a number |
| `footnote_marks` | Marks the reader wrote as `[^n]` |
| `cell_lines_found` | Lines where the reader found two or more cells: a tab from pdf-parse, ` \| ` from pdfjs |
| `cell_lines_stored` | Lines that still show their cells once chunkText has run |
| `chunks_starting_with_number` | Chunks whose first line starts with a number, as a chunk cut inside a table does |

### Score a reader against the right answer

Put a document's correct text beside its PDF, or in the folder `--truth` names: `budget.html`, `budget.md` or `budget.txt` for `budget.pdf`. An HTML page exported from the spreadsheet or document the PDF came from works best, because its tables mark every cell. A hand-written Markdown file works too: each line with a `|` is a table row. Superscripts (`<sup>`) and `[^n]` count as footnote marks, not numbers. `test/fixtures` has fictional examples.

With a truth file, the summary adds:

| Column | What it counts |
| --- | --- |
| `number_recall` | The share of the truth's numbers in the stored text, occurrence by occurrence |
| `numbers_missing`, `numbers_extra` | Numbers the stored text lacks, and numbers it has that the truth hasn't: misread, fused or split. `compare.md` lists them |
| `rows_kept`, `rows_expected` | Table rows with two or more numbers, and how many have their label's first two words and all their numbers, in order, on one stored line |

Today's reader loses the fee schedule's rows, for example: chunkText turns `44⇥604⇥103` (lot, unit, entitlement) into `44 604 103`, which reads as one number. After adding or fixing truth files, `node src/cli.ts report --output out` scores the saved texts again without reading the PDFs.

## Check a reader against the receptionist's search

The real test is whether the knowledge search hands the receptionist the passage with the answer. `upload` sends one reader's text to a test business as a Markdown file. The deployment stores a Markdown file's text as it is, through the same chunkText, so the business then holds what that reader would have given the receptionist. `evaluate` asks questions through `lobbystack knowledge search` and checks each answer is in a passage it hands over.

These commands run the repository's lobbystack CLI with its saved profile, or `LOBBYSTACK_URL`, `LOBBYSTACK_API_KEY` and `LOBBYSTACK_BUSINESS`. Build the CLI once from the repository's root:

```bash
pnpm --filter @lobbystack/cli build
```

Then, from this folder, with a business used only for testing:

```bash
node src/cli.ts upload --output out --parser pdfjs --business <test business id> --dry-run
node src/cli.ts upload --output out --parser pdfjs --business <test business id>
node src/cli.ts evaluate --questions questions.csv --output out --label pdfjs --business <test business id>
node src/cli.ts remove --output out --business <test business id>
```

- `upload` tags each file `pdf-parsing` and `parser:<name>` (add more with `--tag`), titles it `<document> (<reader>)`, waits until it's read, and records it in `out/uploads.json`. It skips a document already uploaded for that reader. `--source pdf` uploads the PDFs themselves instead, which the deployment reads with its own reader, the improved one since fork PR #137 unless its worker has `KNOWLEDGE_PDF_READER=original`: a baseline from the deployment itself.
- `evaluate` reads a CSV or JSON file of questions with `question`, `answer` and, optionally, `document` (the PDF's name without `.pdf`) and `page`. An answer with numbers is found when a passage holds all of them in canonical form; other answers when a passage holds their words. It writes `out/evaluations/<label>/results.md` and `results.json`, with each search's whole answer in `searches/`.
- `remove` deletes from the business exactly the sources `uploads.json` lists, and nothing else. `--parser <name>` limits it to one reader's uploads, and `--dry-run` lists them first.

The search reads the whole business, so check one reader at a time: upload, evaluate, remove, then the next reader. Or give each reader its own test business.

```csv
question,answer,document
What is the 2026 budget for elevator maintenance?,"15,000",budget
What is the building deductible?,"$25,000",notes
```

## Keep the baseline exact

```bash
npm run check-copy
```

It compares the reader and `chunkText` with the repository's files and the pinned library versions with the worker's lockfile, and exits with 1 when anything differs. Line endings don't count, so an older Windows checkout whose files have CRLF still matches. `node src/cli.ts check-copy --fix` copies the files again; a version it reports is fixed with the `npm install --save-exact` it prints. The tests run the same check.

## Run the tests

```bash
npm test
npm run typecheck
```

The OCR test runs once tesseract.js's English and French language files are cached in `.cache/tesseract`: the first OCR downloads them there, about 6 MB from jsDelivr, or set `PDF_PARSING_OCR_TESTS=1` to let the test download them. The tool runs OCR from that folder for the same reason.

## Know what it doesn't do

- It doesn't change how text is chunked. Both readers' text goes through the repository's chunkText, so the design's chunks around tables can't be measured here yet.
- The scorer checks numbers and rows. A two-level header flattened into one line or a blank cell that shifts the values after it isn't caught unless the row loses a number.
- The pdfjs reader reads PDFs only, as the worker's improved reader does. The worker reads Word files with mammoth, as `current` does.
