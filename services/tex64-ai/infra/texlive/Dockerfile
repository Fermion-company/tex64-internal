FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-noto-cjk \
      poppler-utils \
      texlive-fonts-recommended \
      texlive-lang-japanese \
      texlive-latex-extra \
      texlive-luatex \
    && rm -rf /var/lib/apt/lists/* \
    && lualatex --version

WORKDIR /vercel/sandbox
