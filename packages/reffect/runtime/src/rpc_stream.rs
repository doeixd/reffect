/// What a body's worker sends: each message as it is ready, then Done (STREAM-002). A WebSocket
/// session may also close itself with a code (WS-005).
#[allow(dead_code)]
enum Outgoing {
    Message(Value),
    Done,
    Close(u16),
}
/// Where a request's messages go: the response body (HTTP) or the session (WebSocket). On a
/// session, a stream waits at `acked` for the client's Ack after each chunk (WS-004); over HTTP
/// there is no gate (STREAM-002).
#[derive(Clone)]
struct Out {
    messages: tokio::sync::mpsc::Sender<Outgoing>,
    acks: Option<std::sync::Arc<tokio::sync::Notify>>,
}
#[allow(dead_code)]
impl Out {
    fn new(messages: tokio::sync::mpsc::Sender<Outgoing>) -> Self {
        Out {
            messages,
            acks: None,
        }
    }
    async fn send(
        &self,
        message: Outgoing,
    ) -> Result<(), tokio::sync::mpsc::error::SendError<Outgoing>> {
        self.messages.send(message).await
    }
    async fn closed(&self) {
        self.messages.closed().await
    }
    /// The client acknowledged the last chunk; at once without a gate.
    async fn acked(&self) {
        if let Some(acks) = &self.acks {
            acks.notified().await
        }
    }
}
/// Where a streaming procedure's chunks come from (LIVE-009).
#[allow(dead_code)]
trait ChunkSource {
    async fn next_chunk(&mut self) -> Option<Vec<Value>>;
}
/// An R stream's encoded chunks, as its sink hands them over.
impl ChunkSource for tokio::sync::mpsc::Receiver<Vec<Value>> {
    async fn next_chunk(&mut self) -> Option<Vec<Value>> {
        self.recv().await
    }
}
/// Queued events, one wait then everything queued, as `Stream.fromQueue`'s takeAll.
impl ChunkSource for tokio::sync::mpsc::Receiver<Value> {
    async fn next_chunk(&mut self) -> Option<Vec<Value>> {
        let mut values = vec![self.recv().await?];
        while let Ok(next) = self.try_recv() {
            values.push(next);
        }
        Some(values)
    }
}
/// Forwards chunks as Chunk messages until the source ends (true) or the client goes away: a
/// closed response or cancellation (false, STREAM-003). The caller drops the source either way,
/// which interrupts an R stream's producer and unsubscribes a live stream.
#[allow(dead_code)]
async fn forward_chunks(
    out: &Out,
    id: &Value,
    tag: &str,
    cancellation: &tokio::sync::watch::Receiver<bool>,
    source: &mut impl ChunkSource,
) -> bool {
    let mut cancellation = cancellation.clone();
    loop {
        if *cancellation.borrow() {
            return false;
        }
        let next = tokio::select! {
            biased;
            _ = cancellation.changed() => return false,
            _ = out.closed() => return false,
            next = source.next_chunk() => next,
        };
        let Some(values) = next else { return true };
        if out
            .send(Outgoing::Message(chunk_message(id, tag, values)))
            .await
            .is_err()
        {
            return false;
        }
        // One unacknowledged chunk at a time on a session, as the official latch allows.
        tokio::select! {
            biased;
            _ = cancellation.changed() => return false,
            _ = out.closed() => return false,
            _ = out.acked() => {}
        }
    }
}
/// The response body: a framed serialization (NDJSON, SchemaBinary) forwards each message as it
/// arrives; JSON writes the array once the worker is done. Dropping it cancels the worker's
/// requests (STREAM-003).
struct PendingResponse {
    lines: tokio::sync::mpsc::Receiver<Outgoing>,
    buffered: Vec<Value>,
    cancellation: Option<std::sync::Arc<tokio::sync::watch::Sender<bool>>>,
}
impl http_body::Body for PendingResponse {
    type Data = Bytes;
    type Error = std::convert::Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        if self.cancellation.is_none() {
            return Poll::Ready(None);
        }
        loop {
            match self.lines.poll_recv(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Outgoing::Message(value))) => {
                    if FRAMED {
                        return Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::from(
                            encode_one(&value),
                        )))));
                    }
                    self.buffered.push(value);
                }
                Poll::Ready(done) => {
                    self.cancellation.take();
                    // A worker that stops before Done failed.
                    let finished = matches!(done, Some(Outgoing::Done));
                    if FRAMED {
                        return if finished {
                            Poll::Ready(None)
                        } else {
                            Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::from(encode_body(
                                vec![invalid("Handler worker failed")],
                            ))))))
                        };
                    }
                    let values = if finished {
                        std::mem::take(&mut self.buffered)
                    } else {
                        vec![invalid("Handler worker failed")]
                    };
                    return Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::from(
                        encode_body(values),
                    )))));
                }
            }
        }
    }
}
impl Drop for PendingResponse {
    fn drop(&mut self) {
        if let Some(cancellation) = self.cancellation.take() {
            let _ = cancellation.send(true);
        }
    }
}
