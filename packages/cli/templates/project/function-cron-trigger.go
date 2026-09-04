package main

import (
	"context"
	"fmt"
)

type TimerEvent struct {
	Messages []struct {
		EventMetadata map[string]any `json:"event_metadata"`
		Details       map[string]any `json:"details"`
	} `json:"messages"`
}

func {{HANDLER}}(ctx context.Context, event TimerEvent) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return fmt.Errorf("cron handler is not implemented (%d messages)", len(event.Messages))
}
