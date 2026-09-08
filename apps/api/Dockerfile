FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/audiohub-api ./cmd/server
FROM alpine:3.20
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/audiohub-api /usr/local/bin/audiohub-api
EXPOSE 8080
ENTRYPOINT ["audiohub-api"]
