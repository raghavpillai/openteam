FROM docker:29-cli AS docker_cli
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 tester
# Available to individual scenarios, but deliberately not installed on PATH.
COPY --from=docker_cli /usr/local/bin/docker /opt/docker/docker
COPY --from=docker_cli /usr/local/libexec/docker/cli-plugins/docker-compose /opt/docker/docker-compose
USER tester
ENV HOME=/home/tester
WORKDIR /home/tester
ENTRYPOINT ["python3", "/fixtures/fresh-install.py"]
