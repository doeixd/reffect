async fn serve(
    listener: tokio::net::TcpListener,
    app: Router,
    shutdown: impl std::future::Future<Output = ()>,
) -> std::io::Result<()> {
    let connections = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let graceful = hyper_util::server::graceful::GracefulShutdown::new();
    let mut shutdown = std::pin::pin!(shutdown);
    loop {
        // At the cap, accepting waits: further clients queue in the OS backlog.
        let permit = tokio::select! {
            permit = connections.clone().acquire_owned() => permit.expect("the connection semaphore is never closed"),
            _ = &mut shutdown => break,
        };
        let stream = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                // A resource error (too many open files) would otherwise spin.
                Err(_) => { tokio::time::sleep(std::time::Duration::from_millis(50)).await; continue; }
            },
            _ = &mut shutdown => break,
        };
        // Like Node's HTTP server, disable Nagle: delayed ACKs otherwise stall multi-segment responses.
        let _ = stream.set_nodelay(true);
        let app = app.clone();
        let service = hyper::service::service_fn(
            move |request: axum::http::Request<hyper::body::Incoming>| {
                tower::ServiceExt::oneshot(app.clone(), request.map(axum::body::Body::new))
            },
        );
        let connection = hyper::server::conn::http1::Builder::new()
            .timer(hyper_util::rt::TokioTimer::new())
            .header_read_timeout(std::time::Duration::from_millis(HEADER_TIMEOUT_MS))
            .serve_connection(hyper_util::rt::TokioIo::new(stream), service);
        let connection = graceful.watch(connection);
        tokio::spawn(async move {
            let _ = connection.await;
            drop(permit);
        });
    }
    graceful.shutdown().await;
    Ok(())
}
