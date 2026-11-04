FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=10000 \
    WEB_CONCURRENCY=1
WORKDIR /app
COPY multiplayer/requirements.txt /app/multiplayer/requirements.txt
RUN pip install --no-cache-dir -r multiplayer/requirements.txt \
    && useradd --create-home --uid 10001 mahjong
COPY calculator_base/ /app/calculator_base/
COPY fan_calculator/ /app/fan_calculator/
COPY simulator/ /app/simulator/
COPY bots/ /app/bots/
COPY multiplayer/ /app/multiplayer/
COPY UI/static/ /app/UI/static/
COPY pictures/ /app/pictures/
USER mahjong
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '10000') + '/healthz', timeout=4)"
CMD ["python", "-m", "multiplayer.web"]
