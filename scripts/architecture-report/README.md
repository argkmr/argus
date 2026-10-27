# Argus architecture PDF

Reusable source-grounded HLD/LLD and vector sequence-diagram report. Review the
native implementation and update `argus_architecture_content.py` before release;
the report intentionally distinguishes verified release evidence, subsequent
source updates and live-account limitations. Historical build evidence remains
in `output/release/BUILD-20260906-309-VERIFICATION.md`; do not rewrite that record
when updating the stable PDF for a newer build.

Requirements: Python with ReportLab, pypdf and Pillow; Poppler `pdftoppm`; macOS
Arial fonts at the paths in the builder. No application server, model call or
remote integration is invoked by these report scripts.

From the repository root:

```sh
python3 scripts/architecture-report/build_argus_architecture.py
mkdir -p tmp/pdfs/native-render
pdftoppm -r 80 -png output/pdf/Argus_Architecture_HLD_LLD_Sequence_Diagrams.pdf tmp/pdfs/native-render/page
python3 scripts/architecture-report/qa_argus_architecture.py
```

Inspect every rendered page/contact sheet after generation. The builder fails
on overflowing content/sequence labels. QA requires every current page to be
rendered after the current PDF and checks page count, source-file existence and text/glyph sanity;
`tmp/pdfs/qa-summary.json` records page/sequence/source counts. It does not replace
visual review. Use a fresh render directory when page counts change so old PNGs
cannot be mistaken for current pages.

Final artifact: `output/pdf/Argus_Architecture_HLD_LLD_Sequence_Diagrams.pdf`.
Disposable renders, contact sheets, extracted text and layout metrics are in
`tmp/pdfs/`, not alongside the reusable source.
