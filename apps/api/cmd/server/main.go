package main

import (
	"audiohub/api/internal/db"
	"audiohub/api/internal/httpapi"
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	ctx := context.Background()
	store, err := db.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer store.Pool.Close()
	srv := &http.Server{Addr: ":" + env("PORT", "8080"), Handler: httpapi.New(store).Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		log.Printf("AudioHub API on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	<-ch
	stop, _ := context.WithTimeout(context.Background(), 10*time.Second)
	_ = srv.Shutdown(stop)
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
