FROM python:3.12-slim
RUN pip install --no-cache-dir numpy \
 && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY train.py /app/train.py
WORKDIR /app
ENV PYTHONUNBUFFERED=1
CMD ["python", "-u", "/app/train.py"]
