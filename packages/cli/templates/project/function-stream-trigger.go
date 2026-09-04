package main

import (
	"context"
	"encoding/json"
	"fmt"
)

type DataStreamsEvent struct {
	Messages []json.RawMessage `json:"messages"`
}

func {{HANDLER}}(ctx context.Context, event DataStreamsEvent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return fmt.Errorf("Data Streams handler is not implemented (%d messages)", len(event.Messages))
}
