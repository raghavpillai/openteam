package util

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"time"

	"golang.ngrok.com/ngrok/v2"
)

type Forwarding struct {
	URL      *url.URL
	Shutdown func()
}

func SetupForwarding(parentCtx context.Context, to string) (*Forwarding, error) {
	authToken := os.Getenv("NGROK_AUTH_TOKEN")
	if authToken == "" {
		return nil, fmt.Errorf("NGROK_AUTH_TOKEN not set")
	}

	ctx, cancel := context.WithCancel(parentCtx)

	agent, err := ngrok.NewAgent(
		ngrok.WithAuthtoken(authToken),
		ngrok.WithAutoConnect(false),
	)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("ngrok.NewAgent failed: %w", err)
	}

	err = agent.Connect(ctx)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("ngrok.Connect failed: %w", err)
	}

	fwd, err := agent.Forward(ctx,
		ngrok.WithUpstream(to),
	)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("ngrok.Forward failed: %w", err)
	}

	if err := waitForEdge(ctx, fwd.URL().String()+"/sse"); err != nil {
		cancel()
		<-fwd.Done()
		return nil, fmt.Errorf("ngrok edge readiness probe failed: %w", err)
	}

	return &Forwarding{
		URL: fwd.URL(),
		Shutdown: func() {
			cancel()
			<-fwd.Done()
		},
	}, nil
}

// agent.Forward() returns before the ngrok edge is routable, causing 404 on the first request.
func waitForEdge(ctx context.Context, probeURL string) error {
	deadline := time.Now().Add(10 * time.Second)
	backoff := 100 * time.Millisecond

	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, probeURL, nil)
		if err != nil {
			return err
		}
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				return nil
			}
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		if backoff < time.Second {
			backoff *= 2
		}
	}
	return fmt.Errorf("ngrok endpoint %s kept returning 404", probeURL)
}
