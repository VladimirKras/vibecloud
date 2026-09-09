package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	// HANDLER_IMPORTS
)

var handlers = map[string]any{
	// HANDLERS
}

type route struct {
	Pattern  string `json:"pattern"`
	Method   string `json:"method"`
	Function string `json:"function"`
}

var configuration struct {
	Kind   string                    `json:"kind"`
	Routes []route                   `json:"routes"`
	Timers map[string]map[string]any `json:"timers"`
}

func init() {
	if err := json.Unmarshal([]byte("MANIFEST"), &configuration); err != nil {
		panic(err)
	}
}

func invoke(ctx context.Context, name string, event map[string]any) (any, error) {
	fn, ok := handlers[name]
	if !ok {
		return nil, fmt.Errorf("unknown handler: %s", name)
	}
	var server http.Handler
	switch target := fn.(type) {
	case http.Handler:
		server = target
	case func(http.ResponseWriter, *http.Request):
		server = http.HandlerFunc(target)
	}
	if server != nil {
		return invokeHTTP(ctx, server, event)
	}
	callable := reflect.ValueOf(fn)
	typ := callable.Type()
	if typ.Kind() != reflect.Func || typ.NumIn() > 2 {
		return nil, fmt.Errorf("handler %s must use a Cloud Functions signature", name)
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	arguments := []reflect.Value{}
	if typ.NumIn() > 0 && typ.In(0) == reflect.TypeOf((*context.Context)(nil)).Elem() {
		arguments = append(arguments, reflect.ValueOf(ctx))
	}
	if typ.NumIn() > len(arguments) {
		if typ.NumIn()-len(arguments) != 1 {
			return nil, fmt.Errorf("handler %s has an invalid signature", name)
		}
		argument := reflect.New(typ.In(len(arguments)))
		switch value := argument.Elem(); {
		case value.Kind() == reflect.String:
			value.SetString(string(payload))
		case value.Kind() == reflect.Slice && value.Type().Elem().Kind() == reflect.Uint8:
			value.SetBytes(payload)
		default:
			if err := json.Unmarshal(payload, argument.Interface()); err != nil {
				return nil, err
			}
		}
		arguments = append(arguments, argument.Elem())
	}
	results := callable.Call(arguments)
	var response any
	for _, result := range results {
		if result.Type().Implements(reflect.TypeOf((*error)(nil)).Elem()) {
			if !result.IsNil() {
				return nil, result.Interface().(error)
			}
		} else {
			response = result.Interface()
		}
	}
	return response, nil
}

func invokeHTTP(ctx context.Context, server http.Handler, event map[string]any) (any, error) {
	body, _ := event["body"].(string)
	if event["isBase64Encoded"] == true {
		decoded, err := base64.StdEncoding.DecodeString(body)
		if err != nil {
			return nil, err
		}
		body = string(decoded)
	}
	method, _ := event["httpMethod"].(string)
	path, _ := event["path"].(string)
	query := gatewayValues(event, "queryStringParameters")
	target := (&url.URL{Path: path, RawQuery: query.Encode()}).String()
	request, err := http.NewRequestWithContext(ctx, method, target, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header = http.Header(gatewayValues(event, "headers"))
	request.Host = request.Header.Get("Host")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	return map[string]any{"statusCode": recorder.Code, "multiValueHeaders": recorder.Header(), "body": base64.StdEncoding.EncodeToString(recorder.Body.Bytes()), "isBase64Encoded": true}, nil
}

// Multi-value fields override their single-value counterparts, including empty lists.
func gatewayValues(event map[string]any, field string) url.Values {
	result := url.Values{}
	for _, name := range []string{field, "multiValue" + strings.ToUpper(field[:1]) + field[1:]} {
		values, _ := event[name].(map[string]any)
		for key, value := range values {
			if field == "headers" {
				key = http.CanonicalHeaderKey(key)
			}
			if items, ok := value.([]any); ok {
				result[key] = nil
				for _, item := range items {
					result.Add(key, fmt.Sprint(item))
				}
			} else if name == field {
				result.Set(key, fmt.Sprint(value))
			}
		}
	}
	return result
}

func Handler(ctx context.Context, event map[string]any) (any, error) {
	if configuration.Kind != "timer" {
		method, _ := event["httpMethod"].(string)
		method = strings.ToUpper(method)
		if configuration.Kind == "websocket" {
			method = "WS"
		}
		path, _ := event["path"].(string)
		// The build has already normalized methods and ordered routes by precedence.
		for _, r := range configuration.Routes {
			if r.Method != method && (r.Method != "ANY" || method == "WS") {
				continue
			}
			wildcard := strings.HasSuffix(r.Pattern, "*")
			prefix := strings.TrimSuffix(r.Pattern, "*")
			if wildcard && !strings.HasPrefix(path, prefix) || !wildcard && path != prefix {
				continue
			}
			event["resource"] = r.Pattern
			event["pathParameters"] = nil
			if wildcard {
				event["resource"] = prefix + "{path+}"
				event["pathParameters"] = map[string]string{"path": path[len(prefix):]}
			}
			return invoke(ctx, r.Function, event)
		}
		return map[string]any{"statusCode": 404, "body": "Not found"}, nil
	}

	messages, ok := event["messages"].([]any)
	if !ok || len(messages) == 0 {
		return nil, fmt.Errorf("expected a timer message batch")
	}
	batches := map[string][]any{}
	order := []string{}
	for _, value := range messages {
		message, _ := value.(map[string]any)
		metadata, _ := message["event_metadata"].(map[string]any)
		details, _ := message["details"].(map[string]any)
		name, _ := details["payload"].(string)
		timer, known := configuration.Timers[name]
		if metadata["event_type"] != "yandex.cloud.events.serverless.triggers.TimerMessage" || !known {
			return nil, fmt.Errorf("unknown timer dispatch target")
		}
		delete(details, "payload")
		for key, value := range timer {
			details[key] = value
		}
		if _, exists := batches[name]; !exists {
			order = append(order, name)
		}
		batches[name] = append(batches[name], message)
	}
	var result any
	for _, name := range order {
		event["messages"] = batches[name]
		var err error
		result, err = invoke(ctx, name, event)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}
