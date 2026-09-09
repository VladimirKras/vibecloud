package main

import (
	"context"
	"encoding/json"
)

type WebSocketRequestContext struct {
	ConnectionID string `json:"connectionId"`
	EventType    string `json:"eventType"`
	MessageID    string `json:"messageId,omitempty"`
}

type WebSocketEvent struct {
	Body           string                  `json:"body"`
	RequestContext WebSocketRequestContext `json:"requestContext"`
}

type WebSocketResponse struct {
	StatusCode int               `json:"statusCode"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       string            `json:"body"`
}

func {{HANDLER}}(ctx context.Context, event WebSocketEvent) (WebSocketResponse, error) {
	if event.RequestContext.EventType != "MESSAGE" {
		return WebSocketResponse{StatusCode: 200, Body: ""}, nil
	}

	requestID, _ := ctx.Value("lambdaRuntimeRequestID").(string)
	body, err := json.Marshal(map[string]any{
		"ok":           true,
		"connectionId": event.RequestContext.ConnectionID,
		"messageId":    event.RequestContext.MessageID,
		"requestId":    requestID,
		"body":         event.Body,
	})
	if err != nil {
		return WebSocketResponse{}, err
	}
	return WebSocketResponse{
		StatusCode: 200,
		Headers:    map[string]string{"content-type": "application/json; charset=utf-8"},
		Body:       string(body),
	}, nil
}
