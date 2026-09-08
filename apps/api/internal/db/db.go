package db

import (
	"context"
	"embed"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaFS embed.FS

type Store struct{ Pool *pgxpool.Pool }

func Open(ctx context.Context, url string) (*Store, error) {
	p, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err = p.Ping(ctx); err != nil {
		return nil, err
	}
	s := &Store{Pool: p}
	if err = s.Migrate(ctx); err != nil {
		return nil, err
	}
	return s, nil
}
func (s *Store) Migrate(ctx context.Context) error {
	b, err := schemaFS.ReadFile("schema.sql")
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, string(b))
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}
