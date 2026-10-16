// ==UserScript==
// @name         Nadine Arsip + Book Naskah
// @namespace    local.nadine.disposisi
// @version      3.2.3
// @description  Arsip terpadu dan alur Book asli v3.0.0; tambahan STOP serta pengunci proses bersama.
// @match        https://satu.kemenkeu.go.id/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      service.kemenkeu.go.id
// @connect      satu-file.kemenkeu.go.id
// @updateURL    https://raw.githubusercontent.com/nugioh911/nadine-tools/main/nadine.user.js
// @downloadURL  https://raw.githubusercontent.com/nugioh911/nadine-tools/main/nadine.user.js
// ==/UserScript==

(function () {
  "use strict";
  const PAGE = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const API = "https://service.kemenkeu.go.id/nadine-nanas";
  const LIST = `${API}/mejaku/mejaku/disposisi`;
  const ARCHIVE = `${API}/gateway/grid/Disposisi/Arsipkan`;
  const ATTACHMENTS = `${API}/gateway/grid/konsepnaskah/LampiranDataDukung`;
  const NEED = ["authorization", "lat", "long", "roleid", "unitid"];
  const HEAD = Object.create(null);
  let items = [],
    chosen = new Set(),
    busy = false,
    stop = false,
    panel = null;

  // Satu pengunci untuk arsip, scan, dan booking. STOP tidak membatalkan request yang sudah terkirim.
  const OP = { kind: null, cancelled: false };
  let duplicateScanVerified = false;
  let detailGeneration = 0;
  let attachmentGeneration = 0;
  function checkStop() {
    if (OP.cancelled) {
      const e = new Error('Dihentikan pengguna. Periksa hasil request terakhir sebelum melanjutkan.');
      e.cancelled = true;
      throw e;
    }
  }
  function beginOperation(kind) {
    if (OP.kind) { setStatus('Masih menjalankan ' + OP.kind + '. Tunggu atau tekan STOP.', 'error'); return false; }
    OP.kind = kind; OP.cancelled = false; stop = false; busy = true;
    const button = document.getElementById('nb-stop-active');
    if (button) { button.hidden = false; button.textContent = 'STOP — ' + kind; }
    return true;
  }
  function endOperation() {
    OP.kind = null; OP.cancelled = false; stop = false; busy = false;
    const button = document.getElementById('nb-stop-active');
    if (button) button.hidden = true;
  }
  function requestStop() {
    if (!OP.kind) return;
    OP.cancelled = true; stop = true;
    setStatus('STOP diterima. Request yang sudah terkirim tetap dapat diproses server.', 'error');
    const status = document.getElementById('book-naskah-status');
    if (status && OP.kind === 'booking') status.textContent = 'STOP diterima. Menunggu langkah aktif selesai.';
  }
  async function operationPause(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      checkStop();
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
    checkStop();
  }

  function capture(k, v) {
    k = String(k || "").toLowerCase();
    if (NEED.includes(k) && v) HEAD[k] = String(v);
  }
  try {
    const old = PAGE.XMLHttpRequest.prototype.setRequestHeader;
    PAGE.XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      capture(k, v);
      return old.apply(this, arguments);
    };
  } catch (e) {}
  try {
    const old = PAGE.fetch;
    PAGE.fetch = function (input, init = {}) {
      try {
        const h = new PAGE.Headers(
          init.headers ||
            (input instanceof PAGE.Request ? input.headers : undefined),
        );
        NEED.forEach((k) => capture(k, h.get(k)));
      } catch (e) {}
      return old.apply(this, arguments);
    };
  } catch (e) {}
  const ready = () => NEED.every((k) => HEAD[k]);
  const key = (x) => `${x.Id}:${x.NdId}`;
  const esc = (x) =>
    String(x ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  const date = (x) => {
    if (!x) return "-";
    const d = new Date(x);
    return isNaN(d)
      ? x
      : new Intl.DateTimeFormat("id-ID", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(d);
  };
  const bytes = (x) => {
    x = Number(x || 0);
    return !x
      ? "-"
      : x < 1024
        ? `${x} B`
        : x < 1048576
          ? `${(x / 1024).toFixed(1)} KB`
          : `${(x / 1048576).toFixed(1)} MB`;
  };
  function headers(json = true) {
    return {
      Accept: json
        ? "application/json, text/plain, */*"
        : "application/pdf,application/octet-stream,*/*",
      ...(json ? { "Content-Type": "application/json" } : {}),
      Authorization: HEAD.authorization || "",
      Lat: HEAD.lat || "",
      Long: HEAD.long || "",
      Roleid: HEAD.roleid || "",
      Unitid: HEAD.unitid || "",
    };
  }
  function req({ method = "GET", url, data }) {
    return new Promise((ok, no) =>
      GM_xmlhttpRequest({
        method,
        url,
        headers: headers(),
        data: data === undefined ? undefined : JSON.stringify(data),
        timeout: 60000,
        onload: (r) => {
          let j;
          try {
            j = JSON.parse(r.responseText || "{}");
          } catch (e) {
            return no(new Error(`Respons bukan JSON, HTTP ${r.status}`));
          }
          if (r.status < 200 || r.status >= 300)
            return no(new Error(j.Message || j.Error || `HTTP ${r.status}`));
          ok(j);
        },
        onerror: () => no(new Error("Request jaringan gagal")),
        ontimeout: () => no(new Error("Request timeout")),
      }),
    );
  }
  function blob(url) {
    return new Promise((ok, no) =>
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: headers(false),
        responseType: "blob",
        timeout: 60000,
        onload: (r) =>
          r.status >= 200 && r.status < 300
            ? ok(
                r.response instanceof Blob
                  ? r.response
                  : new Blob([r.response]),
              )
            : no(new Error(`HTTP ${r.status}`)),
        onerror: () => no(new Error("Request file gagal")),
        ontimeout: () => no(new Error("Request file timeout")),
      }),
    );
  }
  function setStatus(t, type = "info") {
    if (panel) {
      const e = panel.querySelector("#nb-status");
      e.textContent = t;
      e.dataset.type = type;
    }
  }
  function filtered() {
    const q = panel.querySelector("#nb-q").value.trim().toLowerCase(),
      u = panel.querySelector("#nb-u").value;
    return items.filter(
      (x) =>
        (!q ||
          [x.NoNd, x.Perihal, x.Pengirim, x.NdId, x.SifatNd]
            .join(" ")
            .toLowerCase()
            .includes(q)) &&
        (!u || x.SifatNd === u),
    );
  }
  function render() {
    const body = panel.querySelector("#nb-body"),
      list = filtered();
    body.innerHTML =
      list
        .map(
          (x) =>
            `<tr><td><input class="nb-check" type="checkbox" data-key="${esc(key(x))}" ${chosen.has(key(x)) ? "checked" : ""}></td><td>${esc(date(x.TanggalKirim))}</td><td><b>${esc(x.NoNd || "-")}</b><br><small>NdId: ${esc(x.NdId)}</small></td><td><span class="nb-badge">${esc(x.SifatNd || "-")}</span></td><td>${esc(x.Perihal || "-")}<br><small>${esc(x.Pengirim || "-")}</small></td><td><button class="nb-detail" data-key="${esc(key(x))}">Detail</button></td></tr>`,
        )
        .join("") ||
      '<tr><td colspan="6" class="nb-empty">Tidak ada data.</td></tr>';
    body.querySelectorAll(".nb-check").forEach(
      (b) =>
        (b.onchange = () => {
          b.checked ? chosen.add(b.dataset.key) : chosen.delete(b.dataset.key);
          count();
        }),
    );
    body
      .querySelectorAll(".nb-detail")
      .forEach(
        (b) =>
          (b.onclick = () =>
            openDetail(items.find((x) => key(x) === b.dataset.key))),
      );
    count();
  }
  function duplicatePlan(source) {
    const unique = new Map();
    for (const item of source) {
      if (item.Id == null || item.NdId == null || !String(item.NdId).trim()) continue;
      unique.set(key(item), item);
    }
    const byDocument = new Map();
    const numberKey = item => String(item.NoNd ?? '').replace(/\s+/g, '').toUpperCase();
    for (const item of unique.values()) {
      const id = numberKey(item);
      if (!id || id === '-') continue;
      if (!byDocument.has(id)) byDocument.set(id, []);
      byDocument.get(id).push(item);
    }
    const timestamp = item => {
      if (!item.TanggalKirim) return -Infinity;
      const t = new Date(item.TanggalKirim).getTime();
      return Number.isFinite(t) ? t : -Infinity;
    };
    const groups = [], toArchive = [];
    for (const [noNd, records] of byDocument) {
      if (records.length < 2) continue;
      const ordered = [...records].sort((a,b) => {
        const ta = timestamp(a), tb = timestamp(b);
        if (ta !== tb) return ta > tb ? -1 : 1;
        const ka = key(a), kb = key(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      const keep = ordered[0], remove = ordered.slice(1);
      groups.push({noNd, keep, remove}); toArchive.push(...remove);
    }
    return {groups, toArchive};
  }

  let archiveNoticeTimer = null;
  function showArchiveNotice(message, type = 'info') {
    let notice = document.getElementById('nb-archive-notice');
    if (!notice) {
      notice = document.createElement('div'); notice.id = 'nb-archive-notice';
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
      const text = document.createElement('span'); text.className = 'nb-notice-text';
      const close = document.createElement('button'); close.type = 'button'; close.textContent = '×';
      close.setAttribute('aria-label', 'Tutup notifikasi');
      close.onclick = () => { clearTimeout(archiveNoticeTimer); notice.classList.remove('open'); };
      notice.append(text, close); document.body.appendChild(notice);
    }
    notice.querySelector('.nb-notice-text').textContent = message; notice.dataset.type = type;
    notice.classList.add('open');
    clearTimeout(archiveNoticeTimer);
    archiveNoticeTimer = setTimeout(() => notice.classList.remove('open'), 6000);
  }

  async function runDuplicateButton(event) {
    const button = event?.currentTarget || panel.querySelector('#nb-archive-duplicates');
    if (!button || button.dataset.busy === 'true') return;
    if (OP.kind) return showArchiveNotice('Masih menjalankan ' + OP.kind + '. Tunggu atau tekan STOP.');
    button.dataset.busy = 'true'; button.disabled = true; button.setAttribute('aria-busy', 'true');
    button.classList.add('nb-duplicate-working');
    button.innerHTML = '<span class="nb-spinner" aria-hidden="true"></span> Memeriksa duplikat...';
    try {
      // Beri browser kesempatan menampilkan feedback klik sebelum membuka konfirmasi.
      await new Promise(resolve => setTimeout(resolve, 180));
      await archiveDuplicates();
    } catch (e) {
      setStatus(e.message, 'error'); showArchiveNotice(e.message, 'error');
    } finally {
      button.dataset.busy = 'false'; button.removeAttribute('aria-busy');
      button.classList.remove('nb-duplicate-working'); count();
    }
  }

  async function archiveDuplicates() {
    if (OP.kind) return setStatus('Masih menjalankan ' + OP.kind + '. Tunggu atau tekan STOP.', 'error');
    if (!duplicateScanVerified) return setStatus('Jalankan Scan disposisi sampai selesai sebelum mengarsipkan duplikat.', 'error');
    const plan = duplicatePlan(items);
    if (!plan.toArchive.length) {
      const message = 'Tidak ada duplikat. Semua Nomor Naskah Dinas dalam hasil scan sudah unik.';
      setStatus(message, 'info'); showArchiveNotice(message); return;
    }
    const details = plan.groups.slice(0, 12).map(group => {
      const name = String(group.keep.NoNd || group.noNd).replace(/[\r\n]+/g, ' ').slice(0, 150);
      return '- ' + name + ': ' + (group.remove.length + 1) + ' disposisi; arsipkan ' + group.remove.length + ', sisakan 1';
    }).join('\n');
    const summary = 'Arsipkan duplikat berdasarkan Nomor Naskah Dinas yang sama?\n\n' +
      'Cakupan: SELURUH hasil scan, termasuk yang tersembunyi oleh filter pencarian/sifat.\n' +
      'Kelompok duplikat: ' + plan.groups.length + '\n' +
      'Akan diarsipkan: ' + plan.toArchive.length + ' disposisi\n' +
      'Dipertahankan: 1 disposisi dengan TanggalKirim terbaru per kelompok. Jika tanggal sama/tidak valid, pilihan ditentukan berdasarkan ID.\n\n' +
      details + (plan.groups.length > 12 ? '\n... dan ' + (plan.groups.length - 12) + ' kelompok lainnya.' : '') +
      '\n\nLanjutkan arsip duplikat?';
    await archiveItems(plan.toArchive, summary);
  }

  function count() {
    panel.querySelector("#nb-count").textContent =
      `${items.length} surat, ${filtered().length} terlihat, ${chosen.size} dipilih`;
    const duplicateButton = panel.querySelector('#nb-archive-duplicates');
    if (duplicateButton) {
      const total = duplicatePlan(items).toArchive.length;
      if (duplicateButton.dataset.busy !== 'true') {
        duplicateButton.textContent = 'Arsipkan duplikat' + (total ? ' (' + total + ')' : '');
        duplicateButton.disabled = !duplicateScanVerified;
      }
    }
  }
  async function scan() {
    if (!ready()) return setStatus('Header login belum tertangkap. Refresh tab Disposisi lalu coba lagi.', 'error');
    if (!beginOperation('scan')) return;
    duplicateScanVerified = false; count();
    const found = new Map();
    setStatus('Memindai disposisi...');
    try {
      const startISO = panel.querySelector('#nb-start').value;
      const endISO = panel.querySelector('#nb-end').value;
      const valid = value => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const d = new Date(value + 'T00:00:00Z');
        return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
      };
      if ((startISO && !valid(startISO)) || (endISO && !valid(endISO))) throw new Error('Tanggal scan tidak valid.');
      if (startISO && endISO && startISO > endISO) throw new Error('Tanggal awal melebihi tanggal akhir.');
      const apiDate = value => value ? value.split('-').reverse().join('-') : '';
      const p = new URLSearchParams({ limit:'100', offset:'0', latest:'true', tagNd:'', read:'', urgensi:'', general:'',
        startDate:apiDate(startISO), endDate:apiDate(endISO), tenggat:'', sebagai:'', kategoriNaskah:'',
        perihal:'', noNd:'', ndId:'', unitPengirim:'' });
      let total = null;
      for (let offset = 0; ; offset += 100) {
        checkStop(); p.set('offset', String(offset));
        const response = await req({ url: LIST + '?' + p });
        checkStop();
        if (response.Success !== true || !Array.isArray(response.Data)) throw new Error(response.Message || 'Format halaman scan tidak valid.');
        if (response.Total !== undefined && response.Total !== null) {
          const parsed = Number(response.Total);
          if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Total scan tidak valid.');
          total = parsed;
        }
        let added = 0;
        for (const item of response.Data) {
          if (item.Id == null || item.NdId == null) throw new Error('Identitas disposisi tidak lengkap.');
          if (!found.has(key(item))) added++;
          found.set(key(item), item);
        }
        setStatus('Memindai: ' + found.size + (total === null ? '' : '/' + total) + ' disposisi...');
        if (total !== null && offset + response.Data.length >= total) break;
        if (!response.Data.length) {
          if (total !== null && offset < total) throw new Error('Halaman scan kosong sebelum total terpenuhi.');
          break;
        }
        if (offset > 0 && !added) throw new Error('Pagination mengulang data yang sama. Scan dihentikan.');
        if (total === null && response.Data.length < 100) break;
        if (offset >= 100000) throw new Error('Batas pengaman pagination tercapai. Persempit tanggal scan.');
      }
      items = [...found.values()]; duplicateScanVerified = true; chosen.clear(); render();
      setStatus('Scan selesai. ' + items.length + ' disposisi ditemukan.', 'success');
    } catch (e) {
      // Hasil lama dipertahankan; data setengah scan tidak dipromosikan sebagai daftar lengkap.
      setStatus(e.message + ' Daftar sebelumnya dipertahankan; scan baru belum lengkap.', 'error');
    } finally { endOperation(); }
  }

  async function archive() {
    if (OP.kind || !chosen.size) return;
    await archiveItems(items.filter(item => chosen.has(key(item))));
  }

  async function archiveItems(list, confirmation) {
    if (OP.kind) return;
    if (!ready()) return setStatus('Header login belum lengkap. Scan ulang terlebih dahulu.', 'error');
    if (!list.length) return setStatus('Pilihan tidak cocok dengan daftar. Scan ulang.', 'error');
    const size = Number(panel.querySelector('#nb-batch').value);
    if (!Number.isInteger(size) || size < 1 || size > 50) return setStatus('Batch harus bilangan bulat 1–50.', 'error');
    if (!confirm(confirmation || ('Arsipkan ' + list.length + ' disposisi terpilih?'))) return;
    if (!beginOperation('arsip')) return;
    const duplicateButton = panel.querySelector('#nb-archive-duplicates');
    if (duplicateButton?.dataset?.busy === 'true') {
      duplicateButton.innerHTML = '<span class="nb-spinner" aria-hidden="true"></span> Mengarsipkan duplikat...';
    }
    let ok = 0, uncertain = 0;
    try {
      for (let i = 0; i < list.length; i += size) {
        checkStop();
        const part = list.slice(i, i + size);
        setStatus('Mengarsipkan ' + (i + 1) + '–' + (i + part.length) + '/' + list.length + '...');
        try {
          const response = await req({ method:'PATCH', url:ARCHIVE,
            data:{ Alasan:'', Tags:[], alasanArsipkan:null, Ids:part.map(item => ({Id:item.Id, NdId:item.NdId})) } });
          if (response.Success !== true) throw new Error(response.Message || 'Server tidak mengonfirmasi batch arsip.');
          ok += part.length;
          const archived = new Set(part.map(key));
          items = items.filter(item => !archived.has(key(item)));
          archived.forEach(id => chosen.delete(id)); render();
        } catch (e) {
          uncertain += part.length;
          duplicateScanVerified = false; render();
          throw new Error('Batch dihentikan: ' + e.message + ' Periksa melalui scan ulang sebelum mencoba lagi.');
        }
        if (i + size < list.length) await operationPause(600);
      }
      setStatus('Arsip selesai: ' + ok + ' dikonfirmasi server. Scan ulang untuk memeriksa daftar terbaru.', 'success');
    } catch (e) {
      setStatus(e.message + ' Dikonfirmasi: ' + ok + '; belum pasti: ' + uncertain + '; belum dikirim: ' + (list.length-ok-uncertain) + '.', 'error');
    } finally { endOperation(); }
  }

  function dialog() {
    let d = document.querySelector("#nb-dialog");
    if (d) return d;
    d = document.createElement("div");
    d.id = "nb-dialog";
    d.innerHTML = `<div class="nb-card"><header><b id="nb-title">Detail Naskah</b><button id="nb-dclose">×</button></header><nav><button class="nb-tab active" data-tab="doc">Naskah ND</button><button class="nb-tab" data-tab="att">Lampiran <span id="nb-att-count">0</span></button></nav><section class="nb-pane active" data-pane="doc"><div id="nb-pdf">Memuat dokumen...</div><aside id="nb-meta"></aside></section><section class="nb-pane" data-pane="att"><div id="nb-atts">Memuat lampiran...</div></section></div>`;
    document.body.appendChild(d);
    d.querySelector("#nb-dclose").onclick = () => closeDialog();
    d.onclick = (e) => {
      if (e.target === d) closeDialog();
    };
    d.querySelectorAll(".nb-tab").forEach(
      (b) => (b.onclick = () => tab(b.dataset.tab)),
    );
    return d;
  }
  function tab(name) {
    const d = dialog();
    d.querySelectorAll(".nb-tab").forEach((x) =>
      x.classList.toggle("active", x.dataset.tab === name),
    );
    d.querySelectorAll(".nb-pane").forEach((x) =>
      x.classList.toggle("active", x.dataset.pane === name),
    );
  }
  function revoke() {
    document
      .querySelectorAll("#nb-dialog iframe[data-url]")
      .forEach((f) => URL.revokeObjectURL(f.dataset.url));
  }
  function closeDialog() {
    detailGeneration++; attachmentGeneration++;
    closeAttachmentPreview();
    const d = document.querySelector('#nb-dialog');
    if (d) { revoke(); d.classList.remove('open'); }
  }

  async function showPdf(url, title, generation) {
    const host = dialog().querySelector('#nb-pdf');
    host.textContent = 'Memuat PDF...';
    try {
      const b = await blob(url);
      if (generation !== detailGeneration) return;
      if (!(await isPdfBlob(b))) throw new Error('Respons naskah bukan PDF.');
      if (generation !== detailGeneration) return;
      const u = URL.createObjectURL(b);
      host.innerHTML = '<iframe title="' + esc(title) + '"></iframe>';
      const f = host.querySelector('iframe'); f.dataset.url = u; f.src = u;
    } catch (e) { if (generation === detailGeneration) host.textContent = 'PDF gagal dimuat: ' + e.message; }
  }

  function validUrl(v) {
    try {
      const u = new URL(v);
      return u.protocol === "https:" &&
        (u.hostname === "kemenkeu.go.id" ||
          u.hostname.endsWith(".kemenkeu.go.id"))
        ? u.href
        : null;
    } catch (e) {
      return null;
    }
  }
  async function isPdfBlob(fileBlob) {
    if (fileBlob.type === "application/pdf") return true;

    try {
      return (await fileBlob.slice(0, 5).text()) === "%PDF-";
    } catch (e) {
      return false;
    }
  }

  function closeAttachmentPreview() {
    const preview = document.querySelector("#nb-att-preview");
    if (!preview) return;

    const frame = preview.querySelector("iframe[data-url]");
    if (frame?.dataset.url) URL.revokeObjectURL(frame.dataset.url);
    preview.remove();
  }

  function showAttachmentPreview(fileBlob, title) {
    closeAttachmentPreview();

    const objectUrl = URL.createObjectURL(fileBlob);
    const preview = document.createElement("div");
    preview.id = "nb-att-preview";
    preview.innerHTML = `
      <div class="nb-preview-card">
        <header>
          <b>${esc(title || "Preview PDF")}</b>
          <button type="button" class="nb-preview-close" title="Tutup">×</button>
        </header>
        <iframe title="${esc(title || "Preview PDF")}" data-url="${objectUrl}"></iframe>
      </div>
    `;

    document.body.appendChild(preview);
    preview.querySelector("iframe").src = objectUrl;
    preview.querySelector(".nb-preview-close").onclick = closeAttachmentPreview;
    preview.onclick = (event) => {
      if (event.target === preview) closeAttachmentPreview();
    };
  }

  async function previewAtt(a, button) {
    const u = validUrl(a.DownloadPath);
    const originalText = button?.textContent?.trim() || "Preview";
    const generation = ++attachmentGeneration;
    const detail = detailGeneration;

    if (!u) return alert("URL lampiran tidak valid.");
    if (button?.disabled) return;

    if (button) {
      button.disabled = true;
      button.classList.add("is-loading");
      button.innerHTML = '<span class="nb-spinner" aria-hidden="true"></span> Memuat...';
    }

    try {
      const fileBlob = await blob(u);
      const pdf = await isPdfBlob(fileBlob);

      if (!pdf) {
        throw new Error("Bukan PDF.");
      }

      const title = await normalizedDownloadName(a, fileBlob);
      if (generation === attachmentGeneration && detail === detailGeneration && button?.isConnected) showAttachmentPreview(fileBlob, title);

      if (button) {
        button.classList.remove("is-loading");
        button.textContent = originalText;
        button.disabled = false;
      }
    } catch (e) {
      if (button) {
        button.classList.remove("is-loading");
        button.classList.add("is-error");
        button.textContent = "Preview gagal";
      }

      setTimeout(() => {
        if (!button?.isConnected) return;
        button.classList.remove("is-error", "is-loading");
        button.textContent = originalText;
        button.disabled = false;
      }, 2200);

      alert(e.message === "Bukan PDF." ? "Bukan PDF." : `Preview gagal: ${e.message}`);
    }
  }

  async function normalizedDownloadName(a, fileBlob) {
    const rawName =
      a.NameFile || a.NamaFile || a.FileName || "lampiran";
    const safeName = String(rawName)
      .replace(/[\/:*?"<>|]+/g, "_")
      .trim();

    let isPdf = fileBlob.type === "application/pdf";

    if (!isPdf) {
      try {
        const signature = await fileBlob.slice(0, 5).text();
        isPdf = signature === "%PDF-";
      } catch (e) {
        // Jika signature tidak dapat dibaca, gunakan nama dan MIME yang tersedia.
      }
    }

    if (isPdf) {
      const pdfBase = safeName
        .replace(/\.(doc|docx|xls|xlsx|ppt|pptx)\.pdf$/i, "")
        .replace(/\.(doc|docx|xls|xlsx|ppt|pptx)$/i, "")
        .replace(/\.pdf$/i, "");
      return `${pdfBase || "lampiran"}.pdf`;
    }

    return safeName || "lampiran";
  }

  async function downloadAtt(a, button) {
    const u = validUrl(a.DownloadPath);
    const originalText = button?.textContent?.trim() || "Download Asli";

    if (!u) {
      if (button) {
        button.classList.add("is-error");
        button.textContent = "URL tidak valid";
        setTimeout(() => {
          button.classList.remove("is-error");
          button.textContent = originalText;
        }, 2000);
      }
      return alert("URL download tidak valid.");
    }

    if (button?.disabled) return;

    if (button) {
      button.disabled = true;
      button.classList.remove("is-success", "is-error");
      button.classList.add("is-loading");
      button.innerHTML = '<span class="nb-spinner" aria-hidden="true"></span> Mengunduh...';
    }

    try {
      const b = await blob(u),
        o = URL.createObjectURL(b),
        x = document.createElement("a");

      x.href = o;
      x.download = await normalizedDownloadName(a, b);
      document.body.appendChild(x);
      x.click();
      x.remove();
      setTimeout(() => URL.revokeObjectURL(o), 5000);

      if (button) {
        button.classList.remove("is-loading");
        button.classList.add("is-success");
        button.textContent = "Download dimulai";
      }

      setTimeout(() => {
        if (!button?.isConnected) return;
        button.classList.remove("is-success", "is-error", "is-loading");
        button.textContent = originalText;
        button.disabled = false;
      }, 1800);
    } catch (e) {
      if (button) {
        button.classList.remove("is-loading");
        button.classList.add("is-error");
        button.textContent = "Download gagal";
      }

      setTimeout(() => {
        if (!button?.isConnected) return;
        button.classList.remove("is-success", "is-error", "is-loading");
        button.textContent = originalText;
        button.disabled = false;
      }, 2500);

      alert(`Download gagal: ${e.message}`);
    }
  }
  function drawAtt(list) {
    const detailDialog = dialog();
    const attachmentHost = detailDialog.querySelector("#nb-atts");

    detailDialog.querySelector("#nb-att-count").textContent = list.length;

    if (!list.length) {
      attachmentHost.innerHTML =
        '<div class="nb-empty">Tidak ada lampiran.</div>';
      return;
    }

    attachmentHost.innerHTML = list
      .map((attachment, index) => {
        const fileName =
          attachment.NameFile ||
          attachment.NamaFile ||
          attachment.FileName ||
          "Lampiran";

        const downloadEnabled =
          attachment.CanDownload && attachment.DownloadPath;

        return `
          <article class="nb-att" data-index="${index}">
            <div>
              <b>${esc(fileName)}</b>
              <small>
                Upload: ${esc(date(attachment.CreatedDate))}
                | Ukuran: ${esc(bytes(attachment.Size))}
                | TTE: ${attachment.HasDS ? "Ada" : "Tidak ada"}
                | Status: ${esc(attachment.SignStatus ?? "-")}
              </small>
            </div>

            <div class="nb-att-actions">
              <button
                class="preview"
                type="button"
                ${downloadEnabled ? "" : "disabled"}
              >
                Preview
              </button>
              <button
                class="down"
                type="button"
                ${downloadEnabled ? "" : "disabled"}
              >
                Download Asli
              </button>
            </div>
          </article>
        `;
      })
      .join("");

    attachmentHost.querySelectorAll(".nb-att").forEach((card) => {
      const attachment = list[Number(card.dataset.index)];

      const previewButton = card.querySelector(".preview");
      const downloadButton = card.querySelector(".down");

      if (previewButton) {
        previewButton.addEventListener("click", () => {
          previewAtt(attachment, previewButton);
        });
      }

      downloadButton.addEventListener("click", () => {
        downloadAtt(attachment, downloadButton);
      });
    });
  }

  async function loadAtt(item, generation) {
    const d = dialog(); d.querySelector('#nb-att-count').textContent = '…';
    d.querySelector('#nb-atts').textContent = 'Memuat lampiran...';
    try {
      const r = await req({url:ATTACHMENTS + '/' + encodeURIComponent(item.NdId)});
      if (generation !== detailGeneration) return;
      if (r.Success !== true) throw new Error(r.Message || 'Gagal');
      drawAtt(Array.isArray(r.Data?.Lampiran) ? r.Data.Lampiran : []);
    } catch (e) {
      if (generation !== detailGeneration) return;
      d.querySelector('#nb-att-count').textContent = '!';
      d.querySelector('#nb-atts').textContent = 'Gagal memuat lampiran: ' + e.message;
    }
  }

  function openDetail(item) {
    if (!item) return;
    const generation = ++detailGeneration;
    attachmentGeneration++; closeAttachmentPreview();
    const d = dialog();
    revoke();
    tab("doc");
    d.classList.add("open");
    d.querySelector("#nb-title").textContent = item.NoNd || "Detail Naskah";
    d.querySelector("#nb-meta").innerHTML =
      `<h3>Metadata</h3><dl><dt>Nomor</dt><dd>${esc(item.NoNd || "-")}</dd><dt>Urgensi</dt><dd>${esc(item.SifatNd || item.Urgensi || "-")}</dd><dt>Tanggal kirim</dt><dd>${esc(date(item.TanggalKirim))}</dd><dt>Pengirim</dt><dd>${esc(item.Pengirim || "-")}</dd><dt>Perihal</dt><dd>${esc(item.Perihal || "-")}</dd><dt>NdId</dt><dd>${esc(item.NdId)}</dd><dt>ID amplop</dt><dd>${esc(item.Id)}</dd></dl>`;
    showPdf(
      `${API}/${String(item.PathKonsep || "").replace(/^\/+/, "")}`,
      item.NoNd, generation,
    );
    loadAtt(item, generation);
  }

  function isList() {
    const u = new URL(PAGE.location.href);
    return (
      u.pathname === "/nadine/mejaku" &&
      u.searchParams.get("tab") === "disposisi"
    );
  }
  const bellD =
    "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9";
  function bell() {
    return [...document.querySelectorAll("svg path[d]")]
      .find((p) => p.getAttribute("d") === bellD)
      ?.closest('button,a,[role="button"]');
  }

  function initBookModule() {


    if (window.self !== window.top) return;

    const VERSION = '1.0.1';
    const HOTKEY_BOOK = 'F9';

    let sedangBerjalan = false;
    let hotkeySudahDipasang = false;
    let routeWatcherSudahDipasang = false;
    let domWatcherSudahDipasang = false;
    let refreshTimer = null;

    let lastStatus = 'Siap';
    let lastStatusColor = '#64748b';

    let RUN_CONTEXT = null;

    // =========================================================
    // JENIS NASKAH
    // =========================================================

    const JENIS_NASKAH = {
        ND: {
            kode: 'ND',
            nama: 'Nota Dinas'
        },

        S: {
            kode: 'S',
            nama: 'Surat'
        },

        UND: {
            kode: 'UND',
            nama: 'Undangan'
        },

        KET: {
            kode: 'KET',
            nama: 'Surat Keterangan'
        },

        BA: {
            kode: 'BA',
            nama: 'Berita Acara'
        },

        LAP: {
            kode: 'LAP',
            nama: 'Laporan'
        }
    };

    // =========================================================
    // STATE
    // =========================================================

    const STATE = {
        jenis: 'ND',
        jumlah: 1,
        tanggal: getTanggalHariIni()
    };

    // =========================================================
    // CONFIG
    // =========================================================

    const CONFIG = {

        pengirimKey:
            'Kantor Pelayanan Pajak Pratama Gianyar',

        iconTujuanXPath:
            '/html/body/app-root/layout/mejaku-layout/div/div[2]/mat-drawer-container/mat-drawer-content/div/app-editor-index/app-editor-form/div/div[3]/div/div/div[2]/div[2]/div[1]/img',

        checkboxKepadaXPath:
            '//*[@id="mat-checkbox-15"]/label/span[1]',

        simpanDialogXPath:
            '//*[@id="mat-dialog-3"]/app-dialog-kepada/div[3]/div/button[2]',

        kategoriNaskah:
            'Administrasi',

        klasifikasiArsip:
            'Pelaksanaan Tugas Dalam Jabatan',

        timeoutPendek: 4000,
        timeoutSedang: 8000,
        timeoutPanjang: 20000,

        delayKlik: 500,
        delayLoading: 1000,
        delayLongLoading: 3000,

        // waktu diam setelah satu booking selesai
        // sebelum mulai membuat naskah berikutnya
        delayAntarBooking: 2000,

        maxRetry: 2,
        maxRetryPengirim: 3,

        tampilkanKonfirmasi: true,

        jumlahMinimum: 1,
        jumlahMaksimum: 99
    };

    // =========================================================
    // UTILITY
    // =========================================================

    async function sleep(ms) {
        await operationPause(ms);
    }

    function log(...args) {
        console.log('[BOOK NASKAH]', ...args);
    }

    function warn(...args) {
        console.warn('[BOOK NASKAH]', ...args);
    }

    function errorLog(...args) {
        console.error('[BOOK NASKAH]', ...args);
    }

    function normalizeText(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function isHalamanNadine() {

        try {

            const url =
                new URL(location.href);

            return (
                url.hostname === 'satu.kemenkeu.go.id' &&
                url.pathname.startsWith('/nadine/')
            );

        } catch (e) {

            return false;
        }
    }

    function isVisible(el) {

        if (!el) return false;

        const rect =
            el.getBoundingClientRect();

        const style =
            getComputedStyle(el);

        return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
        );
    }

    function isDisabled(el) {

        if (!el) return true;

        return (
            el.disabled ||
            el.getAttribute('disabled') !== null ||
            el.getAttribute('aria-disabled') === 'true' ||
            el.classList.contains('mat-button-disabled') ||
            el.classList.contains('disabled')
        );
    }

    // =========================================================
    // TANGGAL
    // =========================================================

    function getTanggalHariIni() {

        const now =
            new Date();

        const yyyy =
            now.getFullYear();

        const mm =
            String(
                now.getMonth() + 1
            ).padStart(2, '0');

        const dd =
            String(
                now.getDate()
            ).padStart(2, '0');

        return `${yyyy}-${mm}-${dd}`;
    }

    function isValidTanggalISO(value) {

        return (
            /^\d{4}-\d{2}-\d{2}$/
                .test(
                    String(value || '')
                )
        );
    }

    function formatTanggalIndonesia(
        tanggalISO
    ) {

        if (
            !isValidTanggalISO(
                tanggalISO
            )
        ) {

            return tanggalISO;
        }

        const [
            tahun,
            bulan,
            tanggal
        ] =
            tanggalISO
                .split('-')
                .map(Number);

        const namaBulan = [
            'Januari',
            'Februari',
            'Maret',
            'April',
            'Mei',
            'Juni',
            'Juli',
            'Agustus',
            'September',
            'Oktober',
            'November',
            'Desember'
        ];

        return (
            `${tanggal} ` +
            `${namaBulan[bulan - 1]} ` +
            `${tahun}`
        );
    }

    // =========================================================
    // HAL
    // =========================================================

    function buatHal(
        jenisKode,
        urutan,
        total,
        tanggalISO
    ) {

        const jenis =
            JENIS_NASKAH[
                jenisKode
            ];

        if (!jenis) {
            return '';
        }

        return (
            `${urutan}/${total} ` +
            `Book ${jenis.nama} ` +
            `(${formatTanggalIndonesia(tanggalISO)})`
        );
    }

    // =========================================================
    // STATUS
    // =========================================================

    function setStatus(
        msg,
        color = '#2563eb'
    ) {

        const colorMap = {
            '#bfdbfe': '#2563eb',
            '#86efac': '#16a34a',
            '#facc15': '#ca8a04',
            '#f87171': '#dc2626'
        };

        const finalColor =
            colorMap[color] ||
            color;

        lastStatus =
            msg;

        lastStatusColor =
            finalColor;
        const activeStop = document.getElementById('nb-stop-active');
        if (activeStop && OP.kind === 'booking') {
            activeStop.textContent = 'STOP — Booking' + (RUN_CONTEXT ? ' ' + RUN_CONTEXT.urutan + '/' + RUN_CONTEXT.total : '');
            activeStop.title = msg;
        }

        const status =
            document.getElementById(
                'book-naskah-status'
            );

        if (status) {

            status.textContent =
                msg;

            status.style.color =
                finalColor;

            status.title =
                msg;
        }

        log(msg);
    }

    function getStatusProgress(
        teks
    ) {

        if (!RUN_CONTEXT) {
            return teks;
        }

        return (
            `${RUN_CONTEXT.jenisKode} ` +
            `${RUN_CONTEXT.urutan}/` +
            `${RUN_CONTEXT.total} - ` +
            `${teks}`
        );
    }

    // =========================================================
    // XPATH
    // =========================================================

    function getElementByXPath(
        xpath
    ) {

        try {

            const result =
                document.evaluate(
                    xpath,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                );

            return (
                result.singleNodeValue
            );

        } catch (e) {

            warn(
                'XPath error:',
                xpath,
                e
            );

            return null;
        }
    }

    function queryFirstVisible(
        selectors,
        root = document
    ) {

        for (
            const selector
            of selectors
        ) {

            try {

                for (
                    const el
                    of root.querySelectorAll(
                        selector
                    )
                ) {

                    if (
                        isVisible(el)
                    ) {

                        return el;
                    }
                }

            } catch (e) {}
        }

        return null;
    }

    // =========================================================
    // CLICK
    // =========================================================

    function klikReal(
        el,
        nama = 'elemen'
    ) {

        checkStop();
        if (!el) {
            return false;
        }

        try {

            el.scrollIntoView({
                behavior: 'instant',
                block: 'center',
                inline: 'center'
            });

        } catch (e) {}

        try {
            el.focus();
        } catch (e) {}

        const rect =
            el.getBoundingClientRect();

        const opts = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,

            clientX:
                rect.left +
                rect.width / 2,

            clientY:
                rect.top +
                rect.height / 2,

            button: 0,
            buttons: 1
        };

        try {

            el.dispatchEvent(
                new PointerEvent(
                    'pointerover',
                    opts
                )
            );

            el.dispatchEvent(
                new PointerEvent(
                    'pointerdown',
                    opts
                )
            );

            el.dispatchEvent(
                new MouseEvent(
                    'mousedown',
                    opts
                )
            );

            el.dispatchEvent(
                new PointerEvent(
                    'pointerup',
                    opts
                )
            );

            el.dispatchEvent(
                new MouseEvent(
                    'mouseup',
                    opts
                )
            );

            el.dispatchEvent(
                new MouseEvent(
                    'click',
                    opts
                )
            );

            log(
                `✅ Klik: ${nama}`
            );

            return true;

        } catch (e) {

            warn(
                `⚠️ Klik event gagal: ${nama}`
            );

            try {

                el.click();

                log(
                    `✅ Native click: ${nama}`
                );

                return true;

            } catch (e2) {

                errorLog(
                    `❌ Klik gagal: ${nama}`,
                    e2
                );

                return false;
            }
        }
    }

    // =========================================================
    // INPUT
    // =========================================================

    function inputText(
        el,
        value,
        nama = 'input'
    ) {

        checkStop();
        if (!el) {
            return false;
        }

        try {

            el.scrollIntoView({
                behavior: 'instant',
                block: 'center',
                inline: 'center'
            });

        } catch (e) {}

        try {
            el.focus();
        } catch (e) {}

        try {

            let setter;

            if (
                el instanceof
                HTMLTextAreaElement
            ) {

                setter =
                    Object
                        .getOwnPropertyDescriptor(
                            HTMLTextAreaElement.prototype,
                            'value'
                        )
                        .set;

            } else {

                setter =
                    Object
                        .getOwnPropertyDescriptor(
                            HTMLInputElement.prototype,
                            'value'
                        )
                        .set;
            }

            setter.call(
                el,
                value
            );

            el.dispatchEvent(
                new Event(
                    'input',
                    {
                        bubbles: true,
                        composed: true
                    }
                )
            );

            el.dispatchEvent(
                new Event(
                    'change',
                    {
                        bubbles: true,
                        composed: true
                    }
                )
            );

            log(
                `✏️ Input ${nama}:`,
                value
            );

            return true;

        } catch (e) {

            try {

                el.value =
                    value;

                el.dispatchEvent(
                    new Event(
                        'input',
                        {
                            bubbles: true
                        }
                    )
                );

                el.dispatchEvent(
                    new Event(
                        'change',
                        {
                            bubbles: true
                        }
                    )
                );

                return true;

            } catch (e2) {

                errorLog(
                    `Input gagal ${nama}`,
                    e2
                );

                return false;
            }
        }
    }

    // =========================================================
    // WAIT
    // =========================================================

    async function waitFor(
        fn,
        timeoutMs = 10000,
        intervalMs = 300,
        label = 'kondisi'
    ) {

        const start =
            Date.now();

        while (
            Date.now() - start <
            timeoutMs
        ) {

            checkStop();
            try {

                const result =
                    fn();

                if (result) {

                    log(
                        `⏳ waitFor OK: ${label}`
                    );

                    return result;
                }

            } catch (e) {}

            await sleep(
                intervalMs
            );
        }

        warn(
            `⏰ Timeout: ${label}`
        );

        return null;
    }

    async function waitLoadingRingan(
        ms = CONFIG.delayLoading
    ) {

        await sleep(ms);
    }

    // =========================================================
    // CLICKABLE TEXT
    // =========================================================

    function findClickableByText(
        text,
        root = document
    ) {

        const target =
            normalizeText(text);

        const selectors = [
            'button',
            '[role="button"]',
            '.mat-button-wrapper',
            'mat-option',
            '.mat-option',
            '[role="option"]',
            '.ng-option',
            'mat-card',
            'tr',
            'li',
            'div',
            'span'
        ];

        for (
            const selector
            of selectors
        ) {

            const elements =
                root.querySelectorAll(
                    selector
                );

            for (
                const el
                of elements
            ) {

                if (
                    !isVisible(el)
                ) {

                    continue;
                }

                const textElement =
                    normalizeText(
                        el.innerText ||
                        el.textContent ||
                        ''
                    );

                if (
                    !textElement.includes(
                        target
                    )
                ) {

                    continue;
                }

                const rect =
                    el.getBoundingClientRect();

                if (
                    rect.height > 180
                ) {

                    continue;
                }

                const clickable =
                    el.closest('button') ||
                    el.closest('[role="button"]') ||
                    el.closest('mat-option') ||
                    el.closest('.mat-option') ||
                    el.closest('.ng-option') ||
                    el.closest('li') ||
                    el.closest('.cursor-pointer') ||
                    el.closest('mat-card') ||
                    el;

                if (
                    clickable &&
                    isVisible(clickable) &&
                    !isDisabled(clickable)
                ) {

                    return clickable;
                }
            }
        }

        return null;
    }

    // =========================================================
    // PLACEHOLDER
    // =========================================================

    function cariSpanPlaceholder(
        teksDicari
    ) {

        const target =
            normalizeText(
                teksDicari
            );

        const placeholders =
            document.querySelectorAll(
                'span.mat-select-placeholder'
            );

        for (
            const span
            of placeholders
        ) {

            if (
                !isVisible(span)
            ) {

                continue;
            }

            if (
                normalizeText(
                    span.textContent || ''
                ).includes(
                    target
                )
            ) {

                return (
                    span.closest(
                        '.mat-select-value'
                    ) ||

                    span.closest(
                        '.mat-select-trigger'
                    ) ||

                    span.closest(
                        'mat-select'
                    ) ||

                    span
                );
            }
        }

        return null;
    }

    // =========================================================
    // MAT OPTION
    // =========================================================

    function cariMatOption(
        teksDicari
    ) {

        const target =
            normalizeText(
                teksDicari
            );

        const options =
            document.querySelectorAll(
                'mat-option, ' +
                '.mat-option, ' +
                '[role="option"]'
            );

        for (
            const option
            of options
        ) {

            if (
                !isVisible(option)
            ) {

                continue;
            }

            if (
                normalizeText(
                    option.textContent || ''
                ).includes(
                    target
                )
            ) {

                return option;
            }
        }

        return (
            findClickableByText(
                teksDicari
            )
        );
    }

    function cariSpanButton(
        teksDicari,
        root = document
    ) {

        const target =
            normalizeText(
                teksDicari
            );

        const wrappers =
            root.querySelectorAll(
                'span.mat-button-wrapper'
            );

        for (
            const span
            of wrappers
        ) {

            if (
                !isVisible(span)
            ) {

                continue;
            }

            if (
                normalizeText(
                    span.textContent || ''
                ).includes(
                    target
                )
            ) {

                return (
                    span.closest(
                        'button'
                    ) ||
                    span
                );
            }
        }

        return null;
    }

    // =========================================================
    // JENIS NASKAH
    // =========================================================

    function cariJenisNaskah(
        kode
    ) {

        const jenis =
            JENIS_NASKAH[
                kode
            ];

        if (!jenis) {
            return null;
        }

        const nama =
            normalizeText(
                jenis.nama
            );

        const kodeText =
            normalizeText(
                `(${jenis.kode})`
            );

        const elements =
            document.querySelectorAll(
                'mat-card, ' +
                '[role="button"], ' +
                'button, ' +
                '.cursor-pointer, ' +
                'div'
            );

        const kandidat = [];

        for (
            const el
            of elements
        ) {

            if (
                !isVisible(el)
            ) {

                continue;
            }

            const text =
                normalizeText(
                    el.innerText ||
                    el.textContent ||
                    ''
                );

            if (
                !text.includes(nama) ||
                !text.includes(kodeText)
            ) {

                continue;
            }

            const rect =
                el.getBoundingClientRect();

            if (
                rect.height > 220 ||
                rect.width > 500
            ) {

                continue;
            }

            kandidat.push({
                el,
                panjang: text.length,
                area:
                    rect.width *
                    rect.height
            });
        }

        if (
            kandidat.length
        ) {

            kandidat.sort(
                (a, b) => {

                    if (
                        a.panjang !==
                        b.panjang
                    ) {

                        return (
                            a.panjang -
                            b.panjang
                        );
                    }

                    return (
                        a.area -
                        b.area
                    );
                }
            );

            const found =
                kandidat[0].el;

            return (
                found.closest(
                    'mat-card'
                ) ||

                found.closest(
                    '[role="button"]'
                ) ||

                found.closest(
                    'button'
                ) ||

                found.closest(
                    '.cursor-pointer'
                ) ||

                found
            );
        }

        return (
            findClickableByText(
                jenis.nama
            )
        );
    }

    // =========================================================
    // FINDER UTAMA
    // =========================================================

    function cariTombolTulisNaskah() {

        return (
            findClickableByText(
                'Tulis Naskah'
            )
        );
    }

    function cariTombolBukaSidebar() {

        const buttons =
            [
                ...document
                    .querySelectorAll(
                        'button'
                    )
            ].filter(
                isVisible
            );

        for (
            const button
            of buttons
        ) {

            if (
                isDisabled(button)
            ) {

                continue;
            }

            const aria =
                normalizeText(
                    button.getAttribute(
                        'aria-label'
                    ) ||
                    ''
                );

            if (
                aria.includes(
                    'buka menu sidebar'
                )
            ) {

                return button;
            }
        }

        for (
            const button
            of buttons
        ) {

            const aria =
                normalizeText(
                    button.getAttribute(
                        'aria-label'
                    ) ||
                    ''
                );

            if (
                aria.includes('sidebar') ||
                aria.includes('menu')
            ) {

                return button;
            }
        }

        return null;
    }

    function cariTombolSelanjutnyaGeneric() {

        return (
            cariSpanButton(
                'selanjutnya'
            ) ||

            findClickableByText(
                'Selanjutnya'
            )
        );
    }

    function cariFieldHal() {

        const field =
            queryFirstVisible([
                'input[formcontrolname*="hal" i]',
                'textarea[formcontrolname*="hal" i]',
                'input[placeholder*="Hal" i]',
                'textarea[placeholder*="Hal" i]'
            ]);

        if (field) {
            return field;
        }

        const inputs =
            document.querySelectorAll(
                'input:not([type="search"]):not([type="date"]):not([type="number"]), textarea'
            );

        for (
            const input
            of inputs
        ) {

            if (
                isVisible(input)
            ) {

                return input;
            }
        }

        return null;
    }

    function cariIconTujuanPihak() {

        const xpath =
            getElementByXPath(
                CONFIG
                    .iconTujuanXPath
            );

        if (
            xpath &&
            isVisible(xpath)
        ) {

            return xpath;
        }

        const imgs =
            [
                ...document
                    .querySelectorAll(
                        'app-editor-form img, img'
                    )
            ].filter(
                isVisible
            );

        return (
            imgs[0] ||
            null
        );
    }

    function cariCheckboxKepada() {

        const xpath =
            getElementByXPath(
                CONFIG
                    .checkboxKepadaXPath
            );

        if (
            xpath &&
            isVisible(xpath)
        ) {

            return xpath;
        }

        const checkbox =
            document.querySelector(
                'mat-dialog-container mat-checkbox, ' +
                '.mat-dialog-container mat-checkbox, ' +
                '[role="dialog"] mat-checkbox'
            );

        if (
            checkbox &&
            isVisible(checkbox)
        ) {

            const span =
                checkbox.querySelector(
                    'label span.mat-checkbox-inner-container, label span'
                );

            return (
                span ||
                checkbox
            );
        }

        return (
            findClickableByText(
                'Kepada'
            )
        );
    }

    function cariTombolSimpanDialog() {

        const xpath =
            getElementByXPath(
                CONFIG
                    .simpanDialogXPath
            );

        if (
            xpath &&
            isVisible(xpath)
        ) {

            return xpath;
        }

        return (
            findClickableByText(
                'Simpan'
            )
        );
    }

    // =========================================================
    // MORE / TITIK 3
    // =========================================================

    function cariIconMore() {

        const tooltip =
            document.querySelectorAll(
                '[mattooltip="more"]'
            );

        for (
            const el
            of tooltip
        ) {

            if (
                isVisible(el)
            ) {

                return el;
            }
        }

        const icons =
            document.querySelectorAll(
                'mat-icon'
            );

        for (
            const icon
            of icons
        ) {

            if (
                !isVisible(icon)
            ) {

                continue;
            }

            const svg =
                icon.getAttribute(
                    'svgicon'
                ) ||
                '';

            if (
                svg.includes(
                    'dots-horizontal'
                )
            ) {

                return (
                    icon.closest(
                        '[mattooltip="more"]'
                    ) ||

                    icon.closest(
                        'button'
                    ) ||

                    icon
                );
            }
        }

        const svgs =
            document.querySelectorAll(
                'svg'
            );

        for (
            const svg
            of svgs
        ) {

            if (
                !isVisible(svg)
            ) {

                continue;
            }

            const html =
                svg.innerHTML ||
                '';

            if (
                html.includes(
                    'M5 12h.01'
                ) &&

                html.includes(
                    'M12 12h.01'
                ) &&

                html.includes(
                    'M19 12h.01'
                )
            ) {

                return (
                    svg.closest(
                        '[mattooltip="more"]'
                    ) ||

                    svg.closest(
                        'button'
                    ) ||

                    svg.closest(
                        'mat-icon'
                    ) ||

                    svg
                );
            }
        }

        return null;
    }

    function cariMenuItemBooking() {

        const menuItems =
            document.querySelectorAll(
                '[role="menuitem"], ' +
                '.mat-menu-item, ' +
                'button[gaaction="booking"]'
            );

        for (
            const item
            of menuItems
        ) {

            if (
                !isVisible(item)
            ) {

                continue;
            }

            if (
                normalizeText(
                    item.textContent || ''
                ).includes(
                    'booking'
                )
            ) {

                return item;
            }
        }

        return (
            findClickableByText(
                'Booking'
            )
        );
    }

    function cariInputTanggal() {

        const inputs =
            document.querySelectorAll(
                'input[placeholder*="Pilih Tanggal"], ' +
                'input[data-placeholder*="Pilih Tanggal"], ' +
                'input.mat-datepicker-input'
            );

        for (
            const input
            of inputs
        ) {

            if (
                isVisible(input)
            ) {

                return input;
            }
        }

        return null;
    }

    // =========================================================
    // KLASIFIKASI
    // =========================================================

    function cariIconKlasifikasiArsip() {

        const imgs =
            document.querySelectorAll(
                'img'
            );

        for (
            const img
            of imgs
        ) {

            if (
                !isVisible(img)
            ) {

                continue;
            }

            if (
                (
                    img.getAttribute(
                        'src'
                    ) ||
                    ''
                ).includes(
                    'fi-riwayat-nadine'
                )
            ) {

                return img;
            }
        }

        const formImgs =
            document.querySelectorAll(
                'app-editor-form img'
            );

        if (
            formImgs.length >= 2
        ) {

            return formImgs[1];
        }

        return null;
    }

    function cariTombolPilihKlasifikasi() {

        const rows =
            document.querySelectorAll(
                'tr, .mat-row, table tbody tr'
            );

        for (
            const row
            of rows
        ) {

            if (
                !isVisible(row)
            ) {

                continue;
            }

            if (
                normalizeText(
                    row.textContent || ''
                ).includes(
                    normalizeText(
                        CONFIG
                            .klasifikasiArsip
                    )
                )
            ) {

                const buttons =
                    row.querySelectorAll(
                        'button'
                    );

                for (
                    const button
                    of buttons
                ) {

                    if (
                        isVisible(button) &&

                        normalizeText(
                            button.textContent || ''
                        ).includes(
                            'pilih'
                        )
                    ) {

                        return button;
                    }
                }

                return row;
            }
        }

        return null;
    }

    // =========================================================
    // RETRY
    // =========================================================

    async function retryStep(
        fn,
        nama,
        max = CONFIG.maxRetry
    ) {

        for (
            let i = 1;
            i <= max;
            i++
        ) {

            setStatus(
                getStatusProgress(
                    `${nama} (${i}/${max})`
                ),
                '#bfdbfe'
            );

            let berhasil =
                false;

            try {

                berhasil =
                    await fn();

            } catch (e) {

                if (e.cancelled) throw e;
                errorLog(
                    nama,
                    e
                );
            }

            if (
                berhasil
            ) {

                setStatus(
                    getStatusProgress(
                        `${nama} OK`
                    ),
                    '#86efac'
                );

                return true;
            }

            if (
                i < max
            ) {

                setStatus(
                    getStatusProgress(
                        `${nama} gagal, ulang...`
                    ),
                    '#facc15'
                );

                await sleep(800);
            }
        }

        setStatus(
            getStatusProgress(
                `${nama} gagal`
            ),
            '#f87171'
        );

        return false;
    }

    // =========================================================
    // STEP SIDEBAR
    // =========================================================

    async function stepSidebar() {

        let tulis =
            cariTombolTulisNaskah();

        if (
            tulis &&
            isVisible(tulis)
        ) {

            return true;
        }

        setStatus(
            getStatusProgress(
                'Buka menu...'
            ),
            '#bfdbfe'
        );

        const sidebar =
            await waitFor(
                () =>
                    cariTombolBukaSidebar(),

                CONFIG.timeoutSedang,
                300,
                'Tombol menu sidebar'
            );

        if (!sidebar) {
            return false;
        }

        if (
            !klikReal(
                sidebar,
                'Buka Sidebar'
            )
        ) {

            return false;
        }

        tulis =
            await waitFor(
                () =>
                    cariTombolTulisNaskah(),

                CONFIG.timeoutSedang,
                300,
                'Tulis Naskah setelah buka menu'
            );

        return !!tulis;
    }

    // =========================================================
    // TULIS NASKAH
    // =========================================================

    async function stepTulisNaskah() {

        const button =
            await waitFor(
                () =>
                    cariTombolTulisNaskah(),

                CONFIG.timeoutSedang,
                300,
                'Tulis Naskah'
            );

        if (!button) {
            return false;
        }

        if (
            !klikReal(
                button,
                'Tulis Naskah'
            )
        ) {

            return false;
        }

        await sleep(1500);

        return true;
    }

    // =========================================================
    // PILIH JENIS
    // =========================================================

    async function stepPilihJenisNaskah() {

        const jenis =
            JENIS_NASKAH[
                RUN_CONTEXT.jenisKode
            ];

        if (!jenis) {
            return false;
        }

        const target =
            await waitFor(
                () =>
                    cariJenisNaskah(
                        jenis.kode
                    ),

                CONFIG.timeoutPanjang,
                300,
                `${jenis.nama} (${jenis.kode})`
            );

        if (!target) {
            return false;
        }

        if (
            !klikReal(
                target,
                `${jenis.nama} (${jenis.kode})`
            )
        ) {

            return false;
        }

        await sleep(800);

        return true;
    }

    // =========================================================
    // SELANJUTNYA
    // =========================================================

    async function stepSelanjutnya(
        label = 'Selanjutnya'
    ) {

        const button =
            await waitFor(
                () =>
                    cariTombolSelanjutnyaGeneric(),

                CONFIG.timeoutSedang,
                300,
                label
            );

        if (!button) {
            return false;
        }

        if (
            !klikReal(
                button,
                label
            )
        ) {

            return false;
        }

        await sleep(1000);

        return true;
    }

    // =========================================================
    // PENGIRIM
    // =========================================================

    async function stepPengirim() {

        const dropdown =
            await waitFor(
                () =>
                    cariSpanPlaceholder(
                        'pilih pengirim'
                    ),

                CONFIG.timeoutSedang,
                300,
                'Pilih Pengirim'
            );

        if (!dropdown) {
            return false;
        }

        klikReal(
            dropdown,
            'Dropdown Pengirim'
        );

        let opsi =
            await waitFor(
                () =>
                    cariMatOption(
                        CONFIG
                            .pengirimKey
                    ),

                CONFIG.timeoutPanjang,
                400,
                CONFIG.pengirimKey
            );

        if (!opsi) {

            const panel =
                document.querySelector(
                    '.cdk-overlay-pane, ' +
                    '.mat-select-panel, ' +
                    '.ng-dropdown-panel'
                );

            if (panel) {

                panel.scrollTop = 0;

                await sleep(400);

                opsi =
                    cariMatOption(
                        CONFIG
                            .pengirimKey
                    );

                if (!opsi) {

                    panel.scrollTop =
                        panel.scrollHeight;

                    await sleep(400);

                    opsi =
                        cariMatOption(
                            CONFIG
                                .pengirimKey
                        );
                }
            }
        }

        if (!opsi) {
            return false;
        }

        klikReal(
            opsi,
            CONFIG.pengirimKey
        );

        await sleep(
            CONFIG.delayKlik
        );

        return true;
    }

    // =========================================================
    // HAL
    // =========================================================

    async function stepHal() {

        const field =
            await waitFor(
                () =>
                    cariFieldHal(),

                CONFIG.timeoutSedang,
                300,
                'Field Hal'
            );

        if (!field) {
            return false;
        }

        return (
            inputText(
                field,
                RUN_CONTEXT.hal,
                'Hal'
            )
        );
    }

    // =========================================================
    // TUJUAN
    // =========================================================

    async function stepTujuanPihak() {

        const icon =
            await waitFor(
                () =>
                    cariIconTujuanPihak(),

                CONFIG.timeoutSedang,
                300,
                'Icon Tujuan'
            );

        if (!icon) {
            return false;
        }

        klikReal(
            icon,
            'Icon Tujuan'
        );

        await sleep(1000);

        const checkbox =
            await waitFor(
                () =>
                    cariCheckboxKepada(),

                CONFIG.timeoutSedang,
                300,
                'Kepada'
            );

        if (!checkbox) {
            return false;
        }

        klikReal(
            checkbox,
            'Kepada'
        );

        await sleep(500);

        const simpan =
            await waitFor(
                () =>
                    cariTombolSimpanDialog(),

                CONFIG.timeoutSedang,
                300,
                'Simpan Tujuan'
            );

        if (!simpan) {
            return false;
        }

        klikReal(
            simpan,
            'Simpan Tujuan'
        );

        await sleep(1300);

        return true;
    }

    // =========================================================
    // KATEGORI
    // =========================================================

    async function stepKategoriNaskah() {

        const dropdown =
            await waitFor(
                () =>
                    cariSpanPlaceholder(
                        'kategori naskah dinas'
                    ),

                CONFIG.timeoutSedang,
                300,
                'Kategori'
            );

        if (!dropdown) {
            return false;
        }

        klikReal(
            dropdown,
            'Kategori'
        );

        const opsi =
            await waitFor(
                () =>
                    cariMatOption(
                        CONFIG
                            .kategoriNaskah
                    ),

                CONFIG.timeoutPanjang,
                400,
                CONFIG.kategoriNaskah
            );

        if (!opsi) {
            return false;
        }

        klikReal(
            opsi,
            CONFIG.kategoriNaskah
        );

        await sleep(500);

        return true;
    }

    // =========================================================
    // KLASIFIKASI
    // =========================================================

    async function stepKlasifikasiArsip() {

        const icon =
            await waitFor(
                () =>
                    cariIconKlasifikasiArsip(),

                CONFIG.timeoutSedang,
                300,
                'Klasifikasi Arsip'
            );

        if (!icon) {
            return false;
        }

        klikReal(
            icon,
            'Klasifikasi Arsip'
        );

        await sleep(2000);

        const pilih =
            await waitFor(
                () =>
                    cariTombolPilihKlasifikasi(),

                CONFIG.timeoutPanjang,
                300,
                CONFIG.klasifikasiArsip
            );

        if (!pilih) {
            return false;
        }

        klikReal(
            pilih,
            CONFIG.klasifikasiArsip
        );

        await sleep(1000);

        return true;
    }

    // =========================================================
    // KONFIRMASI
    // =========================================================

    async function stepKonfirmasiYa() {

        const button =
            await waitFor(
                () => {

                    const dialogs =
                        [
                            ...document
                                .querySelectorAll(
                                    'mat-dialog-container, ' +
                                    '.mat-dialog-container, ' +
                                    '[role="dialog"], ' +
                                    '.cdk-overlay-pane'
                                )
                        ].filter(
                            isVisible
                        );

                    for (
                        let i =
                            dialogs.length - 1;

                        i >= 0;

                        i--
                    ) {

                        if (
                            !normalizeText(
                                dialogs[i]
                                    .textContent ||
                                ''
                            ).includes(
                                'konfirmasi'
                            )
                        ) {

                            continue;
                        }

                        const buttons =
                            dialogs[i]
                                .querySelectorAll(
                                    'button'
                                );

                        for (
                            const b
                            of buttons
                        ) {

                            if (
                                isVisible(b) &&
                                !isDisabled(b) &&

                                normalizeText(
                                    b.textContent ||
                                    ''
                                ) === 'ya'
                            ) {

                                return b;
                            }
                        }
                    }

                    return null;
                },

                CONFIG.timeoutSedang,
                300,
                'Konfirmasi Ya'
            );

        if (!button) {
            return false;
        }

        klikReal(
            button,
            'Ya'
        );

        await sleep(
            CONFIG.delayLongLoading
        );

        return true;
    }

    // =========================================================
    // MORE / BOOKING
    // =========================================================

    async function stepKlikMore() {

        const more =
            await waitFor(
                () =>
                    cariIconMore(),

                CONFIG.timeoutPanjang,
                500,
                'Icon More'
            );

        if (!more) {
            return false;
        }

        klikReal(
            more,
            'Icon More'
        );

        await sleep(1000);

        return true;
    }

    async function stepPilihBooking() {

        const booking =
            await waitFor(
                () =>
                    cariMenuItemBooking(),

                CONFIG.timeoutSedang,
                300,
                'Booking'
            );

        if (!booking) {
            return false;
        }

        klikReal(
            booking,
            'Booking'
        );

        await sleep(1200);

        return true;
    }

    async function stepInputTanggal() {

        const input =
            await waitFor(
                () =>
                    cariInputTanggal(),

                CONFIG.timeoutSedang,
                300,
                'Tanggal Booking'
            );

        if (!input) {
            return false;
        }

        inputText(
            input,
            RUN_CONTEXT.tanggalISO,
            'Tanggal'
        );

        await sleep(500);

        return true;
    }

    async function stepSimpanBooking() {

        const button =
            await waitFor(
                () =>
                    cariSpanButton(
                        'simpan'
                    ) ||

                    findClickableByText(
                        'Simpan'
                    ),

                CONFIG.timeoutSedang,
                300,
                'Simpan Booking'
            );

        if (!button) {
            return false;
        }

        klikReal(
            button,
            'Simpan Booking'
        );

        await sleep(1500);

        return true;
    }

    // =========================================================
    // FIX v1.0.1
    //
    // NADINE TIDAK KEMBALI KE HALAMAN UTAMA SETELAH BOOKING.
    // JADI JANGAN TUNGGU "TULIS NASKAH" LANGSUNG TERLIHAT.
    //
    // CUKUP TUNGGU DIALOG / LOADING SELESAI.
    // ITERASI BERIKUTNYA AKAN MEMBUKA SIDEBAR LAGI.
    // =========================================================

    async function tungguSetelahSimpanBooking() {

        setStatus(
            getStatusProgress(
                'Booking tersimpan, menyiapkan berikutnya...'
            ),
            '#86efac'
        );

        await waitFor(
            () => {

                const dialogs =
                    [
                        ...document
                            .querySelectorAll(
                                'mat-dialog-container, ' +
                                '.mat-dialog-container, ' +
                                '[role="dialog"]'
                            )
                    ].filter(
                        isVisible
                    );

                const spinners =
                    [
                        ...document
                            .querySelectorAll(
                                '.mat-spinner, ' +
                                '.mat-progress-spinner, ' +
                                '[role="progressbar"], ' +
                                '.spinner, ' +
                                '.loader'
                            )
                    ].filter(
                        isVisible
                    );

                return (
                    dialogs.length === 0 &&
                    spinners.length === 0
                );
            },

            CONFIG.timeoutPanjang,
            400,
            'Selesai setelah Simpan Booking'
        );

        await sleep(
            CONFIG.delayAntarBooking
        );

        return true;
    }

    // =========================================================
    // SATU SIKLUS
    // =========================================================

    async function jalankanSatuBooking() {

        const jenis =
            JENIS_NASKAH[
                RUN_CONTEXT.jenisKode
            ];

        const steps = [

            [
                'Sidebar',
                stepSidebar
            ],

            [
                'Tulis Naskah',
                stepTulisNaskah
            ],

            [
                `Pilih ${jenis.nama}`,
                stepPilihJenisNaskah
            ],

            [
                'Selanjutnya Template',
                () =>
                    stepSelanjutnya(
                        'Selanjutnya Template'
                    )
            ],

            [
                'Pilih Pengirim',
                stepPengirim
            ],

            [
                'Isi Hal',
                stepHal
            ],

            [
                'Tujuan/Pihak',
                stepTujuanPihak
            ],

            [
                'Kategori Naskah',
                stepKategoriNaskah
            ],

            [
                'Klasifikasi Arsip',
                stepKlasifikasiArsip
            ],

            [
                'Selanjutnya Final',
                () =>
                    stepSelanjutnya(
                        'Selanjutnya Final'
                    )
            ],

            [
                'Konfirmasi Ya',
                stepKonfirmasiYa
            ],

            [
                'Klik More',
                stepKlikMore
            ],

            [
                'Pilih Booking',
                stepPilihBooking
            ],

            [
                'Input Tanggal',
                stepInputTanggal
            ],

            [
                'Simpan Booking',
                stepSimpanBooking
            ]
        ];

        for (
            let i = 0;
            i < steps.length;
            i++
        ) {

            const [
                nama,
                fn
            ] =
                steps[i];

            log(
                `===== ` +
                `${RUN_CONTEXT.jenisKode} ` +
                `${RUN_CONTEXT.urutan}/${RUN_CONTEXT.total} ` +
                `STEP ${i + 1}/${steps.length}: ` +
                `${nama} =====`
            );

            const max =
                nama ===
                'Pilih Pengirim'

                    ? CONFIG
                        .maxRetryPengirim

                    : CONFIG
                        .maxRetry;

            const berhasil =
                await retryStep(
                    fn,
                    nama,
                    max
                );

            if (!berhasil) {

                return {
                    berhasil: false,
                    step: nama
                };
            }

            await sleep(400);
        }

        return {
            berhasil: true,
            step: null
        };
    }

    // =========================================================
    // JUMLAH
    // =========================================================

    function normalisasiJumlah(
        value
    ) {

        let jumlah =
            parseInt(
                value,
                10
            );

        if (
            !Number.isFinite(
                jumlah
            )
        ) {

            jumlah = 1;
        }

        return Math.max(
            CONFIG.jumlahMinimum,

            Math.min(
                CONFIG.jumlahMaksimum,
                jumlah
            )
        );
    }

    // =========================================================
    // PANEL STATE
    // =========================================================

    function syncStateDariPanel() {

        const jenis =
            document.getElementById(
                'book-naskah-jenis'
            );

        const jumlah =
            document.getElementById(
                'book-naskah-jumlah'
            );

        const tanggal =
            document.getElementById(
                'book-naskah-tanggal'
            );

        if (
            jenis &&
            JENIS_NASKAH[
                jenis.value
            ]
        ) {

            STATE.jenis =
                jenis.value;
        }

        if (jumlah) {

            STATE.jumlah =
                normalisasiJumlah(
                    jumlah.value
                );

            jumlah.value =
                STATE.jumlah;
        }

        if (
            tanggal &&
            isValidTanggalISO(
                tanggal.value
            )
        ) {

            STATE.tanggal =
                tanggal.value;
        }
    }

    function updateBookButtonLabel() {

        const text =
            document.getElementById(
                'book-naskah-button-text'
            );

        if (text) {

            text.textContent =
                `BOOK ${STATE.jenis}`;
        }
    }

    function setPanelDisabled(
        disabled
    ) {

        const ids = [
            'book-naskah-jenis',
            'book-naskah-jumlah',
            'book-naskah-tanggal',
            'book-naskah-run'
        ];

        for (
            const id
            of ids
        ) {

            const el =
                document.getElementById(
                    id
                );

            if (!el) {
                continue;
            }

            el.disabled =
                disabled;
        }
    }

    // =========================================================
    // MAIN
    // =========================================================

    async function bookNaskah() {

        if (
            sedangBerjalan
        ) {

            setStatus(
                'Masih berjalan...',
                '#facc15'
            );

            return;
        }

        if (OP.kind) {
            setStatus('Masih menjalankan ' + OP.kind + '. Tunggu atau tekan STOP.', '#facc15');
            return;
        }
        syncStateDariPanel();

        const jenis =
            JENIS_NASKAH[
                STATE.jenis
            ];

        const jumlah =
            normalisasiJumlah(
                STATE.jumlah
            );

        const tanggalISO =
            STATE.tanggal;

        if (
            !jenis ||
            !isValidTanggalISO(
                tanggalISO
            )
        ) {

            alert(
                'Konfigurasi booking tidak valid.'
            );

            return;
        }

        if (
            CONFIG.tampilkanKonfirmasi
        ) {

            const pertama =
                buatHal(
                    STATE.jenis,
                    1,
                    jumlah,
                    tanggalISO
                );

            const terakhir =
                buatHal(
                    STATE.jenis,
                    jumlah,
                    jumlah,
                    tanggalISO
                );

            const lanjut =
                confirm(
                    `Jalankan BOOK NASKAH?\n\n` +

                    `Jenis: ${jenis.nama} (${jenis.kode})\n` +

                    `Jumlah: ${jumlah}\n` +

                    `Tanggal: ${formatTanggalIndonesia(tanggalISO)}\n\n` +

                    `Hal pertama:\n${pertama}\n\n` +

                    (
                        jumlah > 1
                            ? `Hal terakhir:\n${terakhir}\n\n`
                            : ''
                    ) +

                    `Mulai booking?`
                );

            if (!lanjut) {
                return;
            }
        }

        if (!beginOperation('booking')) return;
        const panelWasOpen = panel.classList.contains('open');
        panel.classList.remove('open');
        sedangBerjalan = true;

        setPanelDisabled(
            true
        );

        try {

            for (
                let urutan = 1;
                urutan <= jumlah;
                urutan++
            ) {

                checkStop();
                RUN_CONTEXT = {

                    jenisKode:
                        STATE.jenis,

                    jenisNama:
                        jenis.nama,

                    urutan,

                    total:
                        jumlah,

                    tanggalISO,

                    hal:
                        buatHal(
                            STATE.jenis,
                            urutan,
                            jumlah,
                            tanggalISO
                        )
                };

                setStatus(
                    `${jenis.kode} ` +
                    `${urutan}/${jumlah} - Mulai...`,
                    '#bfdbfe'
                );

                log(
                    '=============================='
                );

                log(
                    `BOOKING ${urutan}/${jumlah}`
                );

                log(
                    RUN_CONTEXT.hal
                );

                log(
                    '=============================='
                );

                const hasil =
                    await jalankanSatuBooking();

                if (
                    !hasil.berhasil
                ) {

                    setStatus(
                        `Gagal ${jenis.kode} ` +
                        `${urutan}/${jumlah}: ` +
                        `${hasil.step}`,
                        '#f87171'
                    );

                    alert(
                        `❌ BOOKING BERHENTI\n\n` +

                        `Booking: ${urutan}/${jumlah}\n` +

                        `Jenis: ${jenis.nama}\n` +

                        `Gagal: ${hasil.step}\n\n` +

                        `Booking berikutnya tidak dijalankan.`
                    );

                    return;
                }

                setStatus(
                    `${jenis.kode} ` +
                    `${urutan}/${jumlah} - ` +
                    `Tersimpan`,
                    '#86efac'
                );

                // =============================================
                // LOOP FIX
                // =============================================

                if (
                    urutan <
                    jumlah
                ) {

                    await tungguSetelahSimpanBooking();

                    setStatus(
                        `${jenis.kode} ` +
                        `${urutan + 1}/${jumlah} - ` +
                        `Memulai naskah berikutnya...`,
                        '#bfdbfe'
                    );

                    /*
                     * TIDAK ADA LAGI:
                     *
                     * tungguKembaliKeHalamanUtama()
                     *
                     * Nadine boleh tetap berada di halaman
                     * Detail Naskah.
                     *
                     * Iterasi berikutnya akan masuk lagi ke:
                     *
                     * stepSidebar()
                     * -> buka garis tiga / menu
                     * -> Tulis Naskah
                     * -> dst.
                     */
                }
            }

            setStatus(
                `Selesai ${jumlah}/${jumlah} - ${jenis.kode}`,
                '#86efac'
            );

            alert(
                `✅ BOOK NASKAH SELESAI\n\n` +

                `Jenis: ${jenis.nama} (${jenis.kode})\n` +

                `Jumlah: ${jumlah}/${jumlah}\n` +

                `Tanggal: ${formatTanggalIndonesia(tanggalISO)}`
            );

        } catch (e) {

            errorLog(
                'ERROR:',
                e
            );

            setStatus(
                'Error',
                '#f87171'
            );

            if (e.cancelled) {
                setStatus(e.message, '#f87171');
                alert(e.message);
            } else {
                alert('Error. Cek Console.');
            }

        } finally {

            // Cleanup harus berjalan walaupun STOP aktif.
            await new Promise(resolve => setTimeout(resolve, 700));
            endOperation();
            if (panelWasOpen) panel.classList.add('open');

            sedangBerjalan =
                false;

            RUN_CONTEXT =
                null;

            setPanelDisabled(
                false
            );

            updateBookButtonLabel();
        }
    }


    function mountBookPanel() {
        const host = document.getElementById('nb-book-view');
        if (!host || document.getElementById('book-naskah-panel')) return;
        const panelBook = document.createElement('div');
        panelBook.id = 'book-naskah-panel';
        panelBook.innerHTML = `
            <div class="nb-book-card">
                <h3>Book Naskah Nadine</h3>
                <p class="nb-book-note">Pilih jenis naskah, jumlah, dan tanggal booking. Proses berjalan otomatis di halaman Nadine.</p>
                <div class="nb-book-form">
                    <label>Jenis Naskah
                        <select id="book-naskah-jenis">
                            <option value="ND">ND - Nota Dinas</option>
                            <option value="S">S - Surat</option>
                            <option value="UND">UND - Undangan</option>
                            <option value="KET">KET - Surat Keterangan</option>
                            <option value="BA">BA - Berita Acara</option>
                            <option value="LAP">LAP - Laporan</option>
                        </select>
                    </label>
                    <label>Jumlah
                        <input id="book-naskah-jumlah" type="number" min="1" max="99" step="1">
                    </label>
                    <label>Tanggal Booking
                        <input id="book-naskah-tanggal" type="date">
                    </label>
                    <button id="book-naskah-run" type="button" class="primary">
                        <span id="book-naskah-button-text">BOOK ${STATE.jenis}</span>
                        <small>F9</small>
                    </button>
                </div>
                <div id="book-naskah-status" style="color:${lastStatusColor}">${lastStatus}</div>
                <div class="nb-book-warning">Jangan tutup tab atau mengoperasikan halaman selama booking berjalan. Nadine sudah cukup rapuh tanpa dibantu manusia.</div>
            </div>`;
        host.appendChild(panelBook);
        const jenis = panelBook.querySelector('#book-naskah-jenis');
        const jumlah = panelBook.querySelector('#book-naskah-jumlah');
        const tanggal = panelBook.querySelector('#book-naskah-tanggal');
        const button = panelBook.querySelector('#book-naskah-run');
        jenis.value = STATE.jenis;
        jumlah.value = STATE.jumlah;
        tanggal.value = STATE.tanggal;
        jenis.addEventListener('change', () => {
            STATE.jenis = jenis.value;
            updateBookButtonLabel();
        });
        jumlah.addEventListener('change', () => {
            STATE.jumlah = normalisasiJumlah(jumlah.value);
            jumlah.value = STATE.jumlah;
        });
        tanggal.addEventListener('change', () => {
            if (isValidTanggalISO(tanggal.value)) STATE.tanggal = tanggal.value;
        });
        button.onclick = bookNaskah;
        updateBookButtonLabel();
    }

    if (!hotkeySudahDipasang) {
        hotkeySudahDipasang = true;
        const handler = event => {
            if (event.key === HOTKEY_BOOK || event.code === HOTKEY_BOOK) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                bookNaskah();
            }
        };
        window.addEventListener('keydown', handler, true);
        document.addEventListener('keydown', handler, true);
    }
    mountBookPanel();

  }
  function makeUI() {
    if (panel || !document.body) return;
    const st = document.createElement("style");
    st.textContent = `
#nb-launch{width:40px;height:40px;display:none;align-items:center;justify-content:center;border:0;border-radius:50%;padding:0;background:transparent;color:#fff;cursor:pointer;z-index:2147483647}#nb-launch:hover{background:#ffffff24}#nb-launch svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2}
#nb-panel{position:fixed;inset:5vh 3vw;z-index:2147483646;display:none;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 12px 40px #0007;overflow:hidden;font:13px Arial;color:#222}#nb-panel.open{display:flex}.nb-head{display:flex;align-items:center;padding:12px;background:#173f73;color:#fff}.nb-head h2{flex:1;margin:0;font-size:17px}.nb-head button{border:0;background:transparent;color:#fff;font-size:24px}.nb-controls{display:flex;flex-wrap:wrap;gap:8px;padding:10px;background:#f5f7fa;border-bottom:1px solid #ddd}.nb-controls input,.nb-controls select,.nb-controls button{min-height:34px;padding:6px 9px;border:1px solid #bbc2ca;border-radius:6px;background:#fff}.nb-controls #nb-q{min-width:260px;flex:1}#nb-panel .primary{background:#1565c0!important;color:#fff!important}#nb-panel .danger{background:#b42318!important;color:#fff!important}#nb-status{padding:8px 12px;background:#eef3f8}#nb-status[data-type=success]{background:#e8f6ec;color:#176b32}#nb-status[data-type=error]{background:#fdecec;color:#9f1c14}.nb-wrap{overflow:auto;flex:1}#nb-panel table{width:100%;border-collapse:collapse}#nb-panel th{position:sticky;top:0;background:#e8edf3;text-align:left}#nb-panel th,#nb-panel td{padding:8px;border-bottom:1px solid #ddd;vertical-align:top}.nb-badge{padding:3px 6px;border-radius:10px;background:#fff1cc}.nb-detail{padding:6px 10px;border:1px solid #1565c0;border-radius:6px;background:#fff;color:#1565c0}.nb-foot{display:flex;padding:9px 12px;background:#f5f7fa}.nb-foot span:first-child{flex:1}.nb-empty{text-align:center;padding:30px}
#nb-dialog{position:fixed;inset:0;z-index:2147483647;display:none;padding:3vh 3vw;background:#0009}#nb-dialog.open{display:block}.nb-card{height:94vh;display:flex;flex-direction:column;overflow:hidden;border-radius:10px;background:#fff}.nb-card>header{height:48px;display:flex;align-items:center;padding:0 14px;background:#173f73;color:#fff}.nb-card>header b{flex:1}.nb-card>header button{border:0;background:transparent;color:#fff;font-size:26px}.nb-card nav{display:flex;padding:0 14px;border-bottom:1px solid #ddd}.nb-tab{padding:12px 16px 9px;border:0;border-bottom:3px solid transparent;background:#fff;color:#657386;font-weight:bold}.nb-tab.active{border-bottom-color:#0671c1;color:#0671c1}#nb-att-count{display:inline-flex;min-width:21px;height:21px;align-items:center;justify-content:center;margin-left:4px;padding:0 6px;border-radius:12px;background:#f5c953;color:#5b4300}.nb-pane{display:none;min-height:0;flex:1}.nb-pane.active{display:flex}.nb-pane[data-pane=doc]{display:none;grid-template-columns:minmax(0,1fr) 360px}.nb-pane[data-pane=doc].active{display:grid}#nb-pdf{display:flex;align-items:center;justify-content:center;background:#333;color:#fff}#nb-pdf iframe{width:100%;height:100%;border:0;background:#fff}#nb-meta{overflow:auto;padding:18px;border-left:1px solid #ddd}#nb-meta dt{margin-top:12px;font-weight:bold}#nb-meta dd{margin:4px 0;color:#566579;word-break:break-word}.nb-pane[data-pane=att]{overflow:auto;background:#f5f7fa}#nb-atts{width:100%;padding:18px}.nb-att{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;margin-bottom:10px;padding:14px;border:1px solid #d7dce2;border-radius:8px;background:#fff}.nb-att b{display:block;color:#1959a6;overflow-wrap:anywhere}.nb-att small{display:block;margin-top:8px;color:#566579}.nb-att button{margin-left:8px;padding:7px 10px;border:1px solid #1565c0;border-radius:6px;background:#fff;color:#1565c0}.nb-att-actions{display:flex;gap:8px;align-items:center}.nb-att-actions button{margin-left:0}.nb-att .preview{min-width:112px;background:#fff;color:#1565c0}.nb-att .preview.is-loading{background:#5d6b7a;color:#fff;cursor:wait}.nb-att .preview.is-error{background:#b42318;color:#fff}.nb-att .down{min-width:142px;background:#1565c0;color:#fff}.nb-att .down.is-loading{background:#5d6b7a;color:#fff;cursor:wait}.nb-att .down.is-success{background:#18753c;color:#fff}.nb-att .down.is-error{background:#b42318;color:#fff}.nb-att button:disabled{opacity:.75;cursor:not-allowed}.nb-spinner{display:inline-block;width:13px;height:13px;margin-right:7px;border:2px solid #ffffff66;border-top-color:#fff;border-radius:50%;vertical-align:-2px;animation:nb-spin .75s linear infinite}@keyframes nb-spin{to{transform:rotate(360deg)}}#nb-att-preview{position:fixed;inset:0;z-index:2147483648;display:flex;align-items:center;justify-content:center;padding:3vh 3vw;background:#000b}.nb-preview-card{width:94vw;height:94vh;display:flex;flex-direction:column;overflow:hidden;border-radius:10px;background:#fff;box-shadow:0 18px 60px #0008}.nb-preview-card header{height:48px;display:flex;align-items:center;padding:0 14px;background:#173f73;color:#fff}.nb-preview-card header b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nb-preview-close{border:0;background:transparent;color:#fff;font-size:28px;line-height:1;cursor:pointer}.nb-preview-card iframe{width:100%;min-height:0;flex:1;border:0;background:#444}
#nb-panel .nb-main-tabs{display:flex;gap:4px;padding:8px 12px 0;background:#173f73}.nb-main-tab{padding:9px 14px;border:0;border-radius:7px 7px 0 0;background:#315b88;color:#dce8f5;font-weight:bold;cursor:pointer}.nb-main-tab.active{background:#fff;color:#173f73}.nb-main-view{display:none;min-height:0;flex:1;flex-direction:column}.nb-main-view.active{display:flex}#nb-book-view{overflow:auto;background:#f5f7fa;padding:22px}.nb-book-card{max-width:850px;margin:0 auto;padding:22px;border:1px solid #d7dce2;border-radius:10px;background:#fff;box-shadow:0 4px 16px #0001}.nb-book-card h3{margin:0 0 6px;color:#173f73;font-size:20px}.nb-book-note{margin:0 0 20px;color:#566579}.nb-book-form{display:grid;grid-template-columns:minmax(180px,1.5fr) 110px 180px auto;gap:12px;align-items:end}.nb-book-form label{display:flex;flex-direction:column;gap:6px;font-weight:bold;color:#374151}.nb-book-form input,.nb-book-form select,.nb-book-form button{height:40px;box-sizing:border-box;padding:0 10px;border:1px solid #bbc2ca;border-radius:7px;background:#fff}.nb-book-form button{min-width:130px;border-color:#1565c0;cursor:pointer}.nb-book-form button small{margin-left:7px;padding:2px 5px;border-radius:4px;background:#ffffff30}#book-naskah-status{margin-top:18px;padding:12px;border-radius:7px;background:#eef3f8;font-weight:bold}.nb-book-warning{margin-top:12px;color:#7a4b00;font-size:12px}@media(max-width:850px){.nb-book-form{grid-template-columns:1fr 1fr}.nb-book-form button{width:100%}}

`;
    st.textContent += '\n#nb-stop-active{position:fixed;top:12px;right:18px;z-index:2147483647;padding:12px 18px;border:2px solid white;border-radius:8px;background:#b42318;color:white;font:bold 14px Arial;cursor:pointer;box-shadow:0 3px 12px #0005}#nb-stop-active[hidden]{display:none!important}';
    st.textContent += '\n#nb-archive-duplicates{transition:transform .12s ease,box-shadow .12s ease,background .2s ease}#nb-archive-duplicates:not(:disabled):active{transform:scale(.94);box-shadow:inset 0 2px 7px #0005}#nb-archive-duplicates.nb-duplicate-working{background:#5d6b7a!important;opacity:1;cursor:wait;animation:nb-duplicate-pulse 1s ease-in-out infinite}@keyframes nb-duplicate-pulse{50%{box-shadow:0 0 0 4px #b4231822}}#nb-archive-notice{position:fixed;bottom:28px;left:50%;z-index:2147483647;display:flex;gap:18px;align-items:center;max-width:min(560px,85vw);padding:15px 18px;border-radius:10px;background:#173f73;color:#fff;box-shadow:0 8px 28px #0005;font:14px Arial;opacity:0;transform:translate(-50%,16px);pointer-events:none;transition:opacity .2s ease,transform .2s ease}#nb-archive-notice.open{opacity:1;transform:translate(-50%,0);pointer-events:auto}#nb-archive-notice[data-type=error]{background:#b42318}#nb-archive-notice button{padding:0 3px;border:0;background:transparent;color:#fff;font-size:25px;cursor:pointer}@media(prefers-reduced-motion:reduce){#nb-archive-duplicates,#nb-archive-notice{transition:none}#nb-archive-duplicates.nb-duplicate-working,#nb-archive-duplicates .nb-spinner{animation:none}}';
    document.head.appendChild(st);
    const launch = document.createElement("button");
    launch.id = "nb-launch";
    launch.type = "button";
    launch.title = "Nadine Batch Arsip";
    launch.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M4 7.5h16v12H4z"></path><path d="M3 4.5h18v3H3z"></path><path d="M9 11.5h6"></path></svg>';
    document.body.appendChild(launch);
    panel = document.createElement("section");
    panel.id = "nb-panel";
    panel.innerHTML = `<div class="nb-head"><h2>Nadine Arsip + Book Naskah</h2><button id="nb-close">×</button></div><div class="nb-main-tabs"><button class="nb-main-tab active" data-main="archive">Arsip Disposisi</button><button class="nb-main-tab" data-main="book">Book Naskah</button></div><div id="nb-archive-view" class="nb-main-view active"><div class="nb-controls"><button id="nb-scan" class="primary">Scan disposisi</button><label>Dari <input id="nb-start" type="date" value="2025-10-07"></label><label>Sampai <input id="nb-end" type="date"></label><input id="nb-q" type="search" placeholder="Cari nomor, perihal, pengirim, NdId..."><select id="nb-u"><option value="">Semua sifat</option><option>Biasa</option><option>Segera</option><option>Sangat Segera</option></select><button id="nb-select">Pilih yang terlihat</button><button id="nb-clear">Kosongkan pilihan</button><label>Batch <input id="nb-batch" type="number" value="20" min="1" max="50" style="width:65px"></label><button id="nb-archive" class="danger">Arsipkan terpilih</button><button id="nb-archive-duplicates" class="danger" type="button" disabled title="Seluruh hasil scan: Nomor Naskah Dinas sama, sisakan satu disposisi terbaru per nomor">Arsipkan duplikat</button><button id="nb-stop">STOP</button></div><div id="nb-status">Buka tab Disposisi lalu klik Scan disposisi.</div><div class="nb-wrap"><table><thead><tr><th>Pilih</th><th>Tanggal</th><th>Nomor</th><th>Sifat</th><th>Perihal / Pengirim</th><th>Aksi</th></tr></thead><tbody id="nb-body"><tr><td colspan="6" class="nb-empty">Belum dipindai.</td></tr></tbody></table></div><div class="nb-foot"><span id="nb-count">0 surat</span><span>Token hanya di memori tab.</span></div></div><div id="nb-book-view" class="nb-main-view"></div>`;
    document.body.appendChild(panel);
    const activeStop = document.createElement('button');
    activeStop.id = 'nb-stop-active'; activeStop.type = 'button'; activeStop.hidden = true;
    activeStop.textContent = 'STOP'; activeStop.onclick = requestStop;
    document.body.appendChild(activeStop);
    panel.querySelectorAll(".nb-main-tab").forEach((button) => {
      button.onclick = () => {
        panel.querySelectorAll(".nb-main-tab").forEach((x) => x.classList.toggle("active", x === button));
        panel.querySelectorAll(".nb-main-view").forEach((x) => x.classList.toggle("active", x.id === `nb-${button.dataset.main}-view`));
      };
    });
    initBookModule();
    launch.onclick = () => panel.classList.toggle("open");
    panel.querySelector("#nb-close").onclick = () =>
      panel.classList.remove("open");
    panel.querySelector("#nb-scan").onclick = scan;
    panel.querySelector("#nb-q").oninput = render;
    panel.querySelector("#nb-u").onchange = render;
    panel.querySelector("#nb-select").onclick = () => {
      filtered().forEach((x) => chosen.add(key(x)));
      render();
    };
    panel.querySelector("#nb-clear").onclick = () => {
      chosen.clear();
      render();
    };
    panel.querySelector("#nb-archive").onclick = archive;
    panel.querySelector("#nb-archive-duplicates").onclick = runDuplicateButton;
    panel.querySelector("#nb-stop").onclick = requestStop;
    let mountedBell = null;
    function mount() {
      if (!isList()) {
        launch.style.display = "none";
        return;
      }
      launch.style.display = "inline-flex";
      const b = bell();
      if (!b?.parentElement) return;
      if (
        mountedBell === b &&
        launch.parentElement === b.parentElement &&
        launch.nextElementSibling === b
      )
        return;
      b.parentElement.insertBefore(launch, b);
      mountedBell = b;
    }
    mount();
    // Jangan amati seluruh DOM. PDF viewer dan tabel dapat memicu ribuan mutasi lalu membuat halaman macet.
    // Cukup cek posisi tombol secara ringan setiap 2 detik.
    setInterval(mount, 2000);
  }
  if (document.body) makeUI();
  else document.addEventListener("DOMContentLoaded", makeUI, { once: true });
})();

