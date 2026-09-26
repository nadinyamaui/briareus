(() => {
  if (!location.pathname.startsWith('/preview-feedback/')) return;
  const { api, esc, content, title, status } = window.BriareusOperations;
  const id = encodeURIComponent(location.pathname.split('/').pop());
  title('Comment on a preview');
  let bitmap,
    point,
    recorder,
    recordingStream,
    captureStream,
    timer,
    busy = false,
    leaving = false;
  const abort = new AbortController();
  const stopTracks = (stream) => stream?.getTracks().forEach((t) => t.stop());
  addEventListener('pagehide', () => {
    leaving = true;
    abort.abort();
    clearTimeout(timer);
    if (recorder?.state === 'recording') recorder.stop();
    stopTracks(recordingStream);
    stopTracks(captureStream);
    bitmap?.close();
  });
  async function init() {
    try {
      const { links } = await api(`/api/operations/preview/${id}`);
      if (!links.length) {
        status('Start ▶ Run in the conversation, then return here to comment.');
        return;
      }
      content.innerHTML = `<p class="mb-4">Open the preview, then capture its tab or upload a screenshot. Click the image to mark the element and describe the change.</p><label class="block">Preview page URL<input id="feedback-url" type="url" class="my-2 w-full border border-line bg-canvas p-2" value="${esc(links[0].url)}"></label><div class="mb-4 flex flex-wrap gap-3">${links.map((l) => `<a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener">Open ${esc(l.tenant || 'preview')}</a>`).join('')}<button class="btn" id="feedback-capture">Capture preview tab</button><label class="btn">Upload screenshot<input id="feedback-file" type="file" accept="image/png,image/jpeg,image/webp" class="block max-w-full"></label></div><canvas id="feedback-image" class="mb-4 hidden max-w-full cursor-crosshair border border-line" role="img" aria-label="Screenshot: click to mark an element"></canvas><p id="feedback-point" class="mb-3 text-muted"></p><label class="block">Comment<textarea id="feedback-text" class="my-2 w-full border border-line bg-canvas p-2" rows="4" maxlength="12000"></textarea></label><button class="btn" id="feedback-voice" disabled>Record voice note</button> <button class="btn" id="feedback-send">Send to agent</button>`;
      const $ = (key) => document.getElementById(`feedback-${key}`);
      const canvas = $('image'),
        ctx = canvas.getContext('2d');
      function draw() {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (point) {
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = Math.max(3, canvas.width / 400);
          ctx.beginPath();
          ctx.arc(point.x, point.y, Math.max(12, canvas.width / 80), 0, Math.PI * 2);
          ctx.stroke();
          $('point').textContent =
            `Marked (${Math.round(point.x)}, ${Math.round(point.y)}) in a ${canvas.width} × ${canvas.height} screenshot.`;
        }
      }
      async function load(file) {
        if (file.size > 25 * 1024 * 1024) throw new Error('Screenshot must be smaller than 25 MB');
        const next = await createImageBitmap(file);
        if (next.width * next.height > 64000000) {
          next.close();
          throw new Error('Screenshot is too large');
        }
        bitmap?.close();
        bitmap = next;
        point = null;
        const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.classList.remove('hidden');
        $('point').textContent = 'Click the element you want changed.';
        draw();
      }
      canvas.onclick = (event) => {
        const rect = canvas.getBoundingClientRect();
        point = {
          x: Math.min(
            canvas.width - 1,
            Math.max(0, ((event.clientX - rect.left) * canvas.width) / rect.width),
          ),
          y: Math.min(
            canvas.height - 1,
            Math.max(0, ((event.clientY - rect.top) * canvas.height) / rect.height),
          ),
        };
        draw();
      };
      $('file').onchange = async (event) => {
        try {
          if (event.target.files[0]) await load(event.target.files[0]);
        } catch (e) {
          status(e.message);
        }
      };
      $('capture').disabled = !navigator.mediaDevices?.getDisplayMedia;
      $('capture').onclick = async () => {
        try {
          captureStream = await navigator.mediaDevices.getDisplayMedia({
            video: { displaySurface: 'browser' },
            audio: false,
          });
          if (leaving) return;
          const video = document.createElement('video');
          video.srcObject = captureStream;
          await video.play();
          await new Promise((resolve) => video.requestVideoFrameCallback(resolve));
          const screenshot = document.createElement('canvas');
          screenshot.width = video.videoWidth;
          screenshot.height = video.videoHeight;
          screenshot.getContext('2d').drawImage(video, 0, 0);
          await load(await new Promise((resolve) => screenshot.toBlob(resolve, 'image/png')));
          video.srcObject = null;
        } catch (e) {
          status(e.message);
        } finally {
          stopTracks(captureStream);
          captureStream = null;
        }
      };
      const transcription = await api('/api/dev/transcribe').catch(() => ({ available: false }));
      $('voice').disabled =
        !transcription.available || !window.MediaRecorder || !navigator.mediaDevices?.getUserMedia;
      $('voice').onclick = async () => {
        if (recorder?.state === 'recording') {
          recorder.stop();
          return;
        }
        if (busy) return;
        busy = true;
        $('send').disabled = true;
        $('voice').disabled = true;
        try {
          recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (leaving) {
            stopTracks(recordingStream);
            return;
          }
          const parts = [];
          recorder = new MediaRecorder(recordingStream);
          recorder.ondataavailable = (e) => {
            if (e.data.size) parts.push(e.data);
          };
          recorder.onerror = () => {
            status('Microphone recording failed');
            stopTracks(recordingStream);
          };
          recorder.onstop = async () => {
            clearTimeout(timer);
            stopTracks(recordingStream);
            $('voice').disabled = true;
            $('voice').textContent = 'Transcribing…';
            try {
              if (leaving) return;
              const blob = new Blob(parts, { type: recorder.mimeType || 'audio/webm' });
              const response = await fetch('/api/dev/transcribe', {
                method: 'POST',
                headers: { 'Content-Type': blob.type },
                body: blob,
                signal: abort.signal,
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || 'Transcription failed');
              $('text').value = [$('text').value, data.text].filter(Boolean).join('\n');
            } catch (e) {
              if (!leaving) status(e.message);
            } finally {
              busy = false;
              $('voice').disabled = false;
              $('voice').textContent = 'Record voice note';
              $('send').disabled = false;
            }
          };
          recorder.start();
          $('voice').disabled = false;
          $('voice').textContent = 'Stop recording';
          timer = setTimeout(
            () => {
              if (recorder.state === 'recording') recorder.stop();
            },
            5 * 60 * 1000,
          );
        } catch (e) {
          stopTracks(recordingStream);
          status(e.message);
          busy = false;
          $('voice').disabled = false;
          $('send').disabled = false;
        }
      };
      $('send').onclick = async () => {
        if (busy) return;
        if (!bitmap || !point || !$('text').value.trim()) {
          status('Add a screenshot, mark a point and write a comment.');
          return;
        }
        busy = true;
        $('send').disabled = true;
        $('voice').disabled = true;
        try {
          // toBlob snapshots the canvas when called; capture its metadata before yielding too.
          const submission = {
            url: $('url').value,
            text: $('text').value,
            width: canvas.width,
            height: canvas.height,
            ...point,
          };
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
          const response = await fetch('/api/dev/uploads?name=preview-feedback.png', {
            method: 'POST',
            headers: { 'Content-Type': 'image/png' },
            body: blob,
            signal: abort.signal,
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Screenshot upload failed');
          await api(`/api/operations/preview/${id}`, {
            uploadId: data.file.id,
            ...submission,
          });
          location.href = `/sessions/${id}`;
        } catch (e) {
          status(e.message);
          busy = false;
          $('send').disabled = false;
          $('voice').disabled = !transcription.available;
        }
      };
    } catch (e) {
      status(e.message);
    }
  }
  void init();
})();
