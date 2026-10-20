# docx2pdf: LibreOffice (headless) for Word contract templates (docs/contracts.md → Word templates, D7).
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer-nogui fonts-culmus fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY convert.py main.py ./
ENV PYTHONUNBUFFERED=1
# one conversion per instance (Cloud Run concurrency 1): one worker, one thread
CMD exec gunicorn --bind :$PORT --workers 1 --threads 1 --timeout 120 main:app
