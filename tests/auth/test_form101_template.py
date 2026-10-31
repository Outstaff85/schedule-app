"""The Form 101 template stays light (docs/form101.md → Building the PDF): its
fields use the PDF's own Helvetica, with no font file of their own. The full
Calibri the template once carried for its fields added ~586 KB to every Form 101."""
import pathlib

TEMPLATE = pathlib.Path(__file__).resolve().parents[2] / "functions" / "assets" / "form101" / "v1.pdf"


def test_the_template_carries_no_full_font():
    assert TEMPLATE.stat().st_size < 200 * 1024, TEMPLATE.stat().st_size
