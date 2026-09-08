FROM golang:1.23-alpine AS build
WORKDIR /src

# Download dependencies
COPY go.mod go.sum* ./
RUN go mod download

# Build binary
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/audiohub-api ./cmd/server

# Production stage
FROM alpine:3.20
RUN apk --no-cache add ca-certificates tzdata ffmpeg yt-dlp python3 && \
    adduser -D -u 10001 app

USER app
WORKDIR /app

COPY --from=build /out/audiohub-api /usr/local/bin/audiohub-api

EXPOSE 8080
ENTRYPOINT ["audiohub-api"]
