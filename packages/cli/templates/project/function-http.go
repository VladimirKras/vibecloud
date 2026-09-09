package main

import (
	"context"
	"encoding/json"
)

type HttpEvent struct {
	HTTPMethod string `json:"httpMethod"`
	Path       string `json:"path"`
}

type HttpResponse struct {
	StatusCode int               `json:"statusCode"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       string            `json:"body"`
}

func {{HANDLER}}(ctx context.Context, event HttpEvent) (HttpResponse, error) {
	requestID, _ := ctx.Value("lambdaRuntimeRequestID").(string)
	body, err := json.Marshal(map[string]any{
		"ok":        true,
		"method":    event.HTTPMethod,
		"path":      event.Path,
		"requestId": requestID,
	})
	if err != nil {
		return HttpResponse{}, err
	}
	return HttpResponse{
		StatusCode: 200,
		Headers:    map[string]string{"content-type": "application/json; charset=utf-8"},
		Body:       string(body),
	}, nil
}
