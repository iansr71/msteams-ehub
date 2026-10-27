#!/usr/bin/env python3
"""
Regenerates the binary extraction fixtures in apps/indexer/src/extractors/__fixtures__/.

All content is invented sample text. Requires: reportlab, pypdf, python-docx, python-pptx,
msoffcrypto-tool. Run from the repository root:

    python3 scripts/fixtures/generate_extraction_fixtures.py
"""

import io
import os
import sys

import msoffcrypto
from docx import Document
from pptx import Presentation
from pptx.util import Inches
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

OUT = os.path.join("apps", "indexer", "src", "extractors", "__fixtures__")
PASSWORD = "fixture-password"


def write(name: str, data: bytes) -> None:
    with open(os.path.join(OUT, name), "wb") as handle:
        handle.write(data)
    print(f"wrote {name} ({len(data)} bytes)")


def pdf_bytes(pages: list[list[str]], *, title: str = "Fixture") -> bytes:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4, invariant=1)
    pdf.setTitle(title)
    for lines in pages:
        y = 800
        for line in lines:
            if line.startswith("# "):
                pdf.setFont("Helvetica-Bold", 16)
                line = line[2:]
            else:
                pdf.setFont("Helvetica", 11)
            pdf.drawString(72, y, line)
            y -= 22
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def sample_pdf() -> bytes:
    return pdf_bytes(
        [
            ["# Consultation checklist", "Confirm the client's medical history before treatment.",
             "Record allergies in the client profile."],
            ["# Aftercare", "Advise the client to avoid direct sun for 48 hours."],
            ["# Escalation", "Contact the branch manager for any adverse reaction."],
        ],
        title="Consultation checklist",
    )


def encrypted_pdf(source: bytes) -> bytes:
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(source)))
    writer.encrypt(user_password=PASSWORD, owner_password=PASSWORD, algorithm="AES-128")
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def blank_pdf() -> bytes:
    # A page with no text layer, like a scanned document (OCR is out of scope).
    return pdf_bytes([[]], title="Scanned")


def sample_docx() -> bytes:
    document = Document()
    document.core_properties.title = "Aftercare guide"
    document.add_heading("Aftercare guide", level=1)
    document.add_paragraph("Follow these steps after every chemical peel.")
    document.add_heading("First 24 hours", level=2)
    document.add_paragraph("Apply the recommended moisturiser twice daily.", style="List Bullet")
    document.add_paragraph("Avoid makeup on treated areas.", style="List Bullet")
    document.add_heading("Products", level=2)
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Product"
    table.cell(0, 1).text = "Use"
    table.cell(1, 0).text = "Gentle cleanser"
    table.cell(1, 1).text = "Morning and evening"
    document.add_paragraph("Contact the branch if redness lasts more than three days.")
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def empty_docx() -> bytes:
    buffer = io.BytesIO()
    Document().save(buffer)
    return buffer.getvalue()


def encrypt_office(source: bytes) -> bytes:
    file = msoffcrypto.OfficeFile(io.BytesIO(source))
    output = io.BytesIO()
    file.encrypt(PASSWORD, output)
    return output.getvalue()


def sample_pptx() -> bytes:
    presentation = Presentation()
    slides = [
        ("Branch induction", ["Welcome to Skin Renewal training."]),
        ("Opening procedure", ["Disarm the alarm.", "Switch on treatment devices.", "Check the day's bookings."]),
        ("Closing procedure", ["Complete the cash-up.", "Arm the alarm."]),
    ]
    for title, bullets in slides:
        slide = presentation.slides.add_slide(presentation.slide_layouts[1])
        slide.shapes.title.text = title
        body = slide.placeholders[1].text_frame
        body.text = bullets[0]
        for bullet in bullets[1:]:
            body.add_paragraph().text = bullet
        slide.notes_slide.notes_text_frame.text = f"Presenter note for {title}."
    # A slide with a picture only, no text: should produce a warning, not a failure.
    blank = presentation.slides.add_slide(presentation.slide_layouts[6])
    blank.shapes.add_textbox(Inches(1), Inches(1), Inches(1), Inches(1))
    buffer = io.BytesIO()
    presentation.save(buffer)
    return buffer.getvalue()


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    pdf = sample_pdf()
    write("sample.pdf", pdf)
    write("encrypted.pdf", encrypted_pdf(pdf))
    write("blank.pdf", blank_pdf())
    docx = sample_docx()
    write("sample.docx", docx)
    write("empty.docx", empty_docx())
    write("encrypted.docx", encrypt_office(docx))
    write("sample.pptx", sample_pptx())
    return 0


if __name__ == "__main__":
    sys.exit(main())
