// 自动恢复 R10 审查的脚本
import http from 'http';

const runId = 'run_e298f3d8dae238d59ee6';
const projectId = 'project_425f8ecf128e46967f97';
const sourceHash = '766e2c1b167499a0d8509f3c4aefde3657b0af040d33ec3f319f24ca3cd840c8';
const expectedVersion = 28;

// 发送 POST 请求到本地 API
const data = JSON.stringify({
  sourceHash: sourceHash,
  expectedVersion: expectedVersion
});

const options = {
  hostname: '127.0.0.1',
  port: 4317,
  path: '/api/projects/' + projectId + '/runs/' + runId + '/prepare-undispatched-review-retry',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Cookie': 'sid=local'
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    try {
      const result = JSON.parse(body);
      console.log('✓ 审查恢复请求已发送');
      console.log('  状态: ' + result.state);
      console.log('  阶段: ' + result.phase);
      console.log('  原因: ' + (result.reason || '(无)'));
    } catch(e) {
      console.log('✗ 响应:', res.statusCode, body.substring(0, 200));
    }
  });
});

req.on('error', (e) => {
  console.error('✗ 请求失败:', e.message);
});

req.write(data);
req.end();
