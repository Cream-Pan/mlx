// 設定
const SERVICE_UUID = "4a5197ff-07ce-499e-8d37-d3d457af549a";
const CHARACTERISTIC_UUID = "fedcba98-7654-3210-fedc-ba9876543210";
const DEVICE_NAME = "MLX R";

// 状態
let device, characteristic, service;
let measureStartEpochMs = null;   // 計測(通知購読開始)時刻
const receivedData = [];          // CSV用
let chart;

let intervalId = null;
let latestSample = null;

// UI要素の取得
const connectButton = document.getElementById("connectButton");
const disconnectButton = document.getElementById("disconnectButton");
const measureButton = document.getElementById("measureButton");
const downloadButton = document.getElementById("downloadButton");
const statusSpan = document.getElementById("status");
const deviceNameSpan = document.getElementById("deviceName");

function formatLocalTimeWithMs(epochMs) {
  const d = new Date(epochMs);
  const pad = (n, w=2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`;
}

function formatLocalTimeForCSV(epochMs) {
  const d = new Date(epochMs);
  const pad = (n, w=2) => String(n).padStart(w, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  const milliseconds = pad(d.getMilliseconds(), 3);
  // ISO 8601形式のローカルタイム文字列を生成
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function updateChart(amb, obj, elapsedS) {
  const maxDataPoints = 50;

  if (!chart) {
    const ctx = document.getElementById("realtimeChart").getContext("2d");
    chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [{
          label: "Ambient (°C)",
          data: [],
          borderColor: "rgb(75, 192, 192)",
          fill: false
        },{
          label: "Object (°C)",
          data: [],
          borderColor: "rgb(255, 99, 132)",
          fill: false
        }]
      },
      options: {
        responsive: true,
        animation: {
          duration: 0 // アニメーションを無効化
        },
        scales: {
          x: {
            title: {
              display: true,
              text: "経過時間 (s)"
            }
          },
          y: {
            beginAtZero: false,
            title: {
              display: true,
              text: "温度 (°C)"
            }
          }
        }
      }
    });
  }

  // データを追加
  chart.data.labels.push(elapsedS.toFixed(1));
  chart.data.datasets[0].data.push(amb);
  chart.data.datasets[1].data.push(obj);

  // データ数が上限を超えたら古いものを削除
  if (chart.data.labels.length > maxDataPoints) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
    chart.data.datasets[1].data.shift();
  }
  chart.update("none");
}

function handleNotification(event) {
  const value = event.target.value;
  if (value.byteLength !== 12) return;

  // 受信時刻（クライアント）
  const recvEpochMs = Date.now();

  // ペイロード：Ambient(float32), Object(float32), SensorElapsed_ms(uint32) (LE)
  const amb = value.getFloat32(0, true);
  const obj = value.getFloat32(4, true);
  const sensorElapsedMs = value.getUint32(8, true);

  latestSample = { amb, obj, sensorElapsedMs, recvEpochMs };
}

function processLatestSample() {
  if (!latestSample) return; // まだサンプルが来てない

  const { amb, obj, sensorElapsedMs, recvEpochMs } = latestSample;
  const sensorElapsedS = sensorElapsedMs / 1000;

  // 計測開始からの経過時間（クライアント側）
  const measureElapsedS = measureStartEpochMs
    ? (recvEpochMs - measureStartEpochMs) / 1000
    : 0;

  // 表示
  document.getElementById("ambValue").textContent = amb.toFixed(4);
  document.getElementById("objValue").textContent = obj.toFixed(4);
  document.getElementById("timeValue").textContent = measureElapsedS.toFixed(2);
  document.getElementById("recvTimeValue").textContent = formatLocalTimeWithMs(recvEpochMs);

  // グラフを更新
  updateChart(amb, obj, measureElapsedS);

  // 記録（CSV：MAXと統一の並び）
  receivedData.push({
    amb,
    obj,
    sensor_elapsed_ms: sensorElapsedMs,
    sensor_elapsed_s: sensorElapsedS,
    measure_elapsed_s: measureElapsedS,
    recv_epoch_ms: recvEpochMs,
    recv_jst: formatLocalTimeForCSV(recvEpochMs)
  });
  // 初回受信でダウンロードを有効化
  if (receivedData.length === 1) {
    downloadButton.disabled = false;
  }
}

function clearDataAndChart() {
    receivedData.length = 0; // データをクリア
    if (chart) {
        chart.data.labels = [];
        chart.data.datasets[0].data = [];
        chart.data.datasets[1].data = [];
        chart.update();
    }
    document.getElementById("ambValue").textContent = "-";
    document.getElementById("objValue").textContent = "-";
    document.getElementById("timeValue").textContent = "-";
    document.getElementById("recvTimeValue").textContent = "-";
    measureStartEpochMs = null;
    measureButton.textContent = "計測開始";

    downloadButton.disabled = true;
}

connectButton.addEventListener("click", async () => {
  try {
    statusSpan.textContent = "接続中...";
    device = await navigator.bluetooth.requestDevice({
      filters: [{ name: DEVICE_NAME }],
      optionalServices: [SERVICE_UUID]
    });
    const server = await device.gatt.connect();
    service = await server.getPrimaryService(SERVICE_UUID);
    characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

    statusSpan.textContent = "接続済み";
    deviceNameSpan.textContent = device.name;
    connectButton.disabled = true;
    disconnectButton.disabled = false;
    measureButton.disabled = false;
    measureButton.textContent = "計測開始";
    downloadButton.disabled = true; 

    device.addEventListener("gattserverdisconnected", () => {
      try { characteristic?.removeEventListener("characteristicvaluechanged", handleNotification); } catch(_) {}
      if (intervalId) { clearInterval(intervalId); intervalId = null; }  
      statusSpan.textContent = "未接続";
      deviceNameSpan.textContent = "-";
      connectButton.disabled = false;
      disconnectButton.disabled = true;
      measureButton.disabled = true;
      clearDataAndChart();
    });
  } catch (e) {
    console.error("エラー:", e);
    alert("接続に失敗しました．コンソールを確認してください．");
    statusSpan.textContent = "未接続";
    deviceNameSpan.textContent = "-";
    connectButton.disabled = false;
    disconnectButton.disabled = true;
    measureButton.disabled = true;
  }
});

disconnectButton.addEventListener("click", async() => {
  if (device && device.gatt.connected) {
    if (measureStartEpochMs) {
      // 計測中の場合は停止
      try { await characteristic.stopNotifications(); } catch(_) {}
    }
    device.gatt.disconnect();
  }
});

measureButton.addEventListener("click", async () => {
  if (!characteristic) {
    alert("まずBLEデバイスに接続してください。");
    return;
  }

  if (measureStartEpochMs) {
    // 計測停止
    try { await characteristic.stopNotifications(); } catch(_) {}
    try { characteristic.removeEventListener("characteristicvaluechanged", handleNotification); } catch(_) {}
    clearInterval(intervalId);
    intervalId = null;
    measureStartEpochMs = null;
    measureButton.textContent = "計測開始";
    console.log("計測停止");
  } else {
    // 計測開始
    receivedData.length = 0;
    if (chart) {
      chart.data.labels = [];
      chart.data.datasets[0].data = [];
      chart.data.datasets[1].data = [];
      chart.update();
    }
    try { characteristic.removeEventListener("characteristicvaluechanged", handleNotification); } catch(_) {}
    characteristic.addEventListener("characteristicvaluechanged", handleNotification);
    await characteristic.startNotifications();

    measureStartEpochMs = Date.now();
    intervalId = setInterval(processLatestSample, 1000);
    connectButton.disabled = true;      // ★計測中は再接続禁止
    downloadButton.disabled = true;     // ★データが来るまで無効化
    measureButton.textContent = "計測停止";
    console.log("計測開始");
  }
});

downloadButton.addEventListener("click", () => {
  if (receivedData.length === 0) {
    alert("ダウンロードするデータがありません．");
    return;
  }
  let csv = "Ambient_C,Object_C,SensorElapsed_ms,SensorElapsed_s,MeasureElapsed_s,RecvEpoch_ms,RecvJST\n";
  for (const r of receivedData) {
    csv += `${r.amb},${r.obj},${r.sensor_elapsed_ms},${r.sensor_elapsed_s},${r.measure_elapsed_s},${r.recv_epoch_ms},${r.recv_jst}\n`;
  }
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mlx90632_data.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

