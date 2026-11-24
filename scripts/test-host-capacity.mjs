/** Owner-authorized 1GiB launch floor. Low-memory tests run serially with
 * 512MiB host headroom; the original parallel-pool reservation stays unchanged. */
export function testHostCapacity(cpuSlots,freeMemoryMiB){
 if(!Number.isSafeInteger(cpuSlots)||cpuSlots<1||!Number.isSafeInteger(freeMemoryMiB)||freeMemoryMiB<0)throw Error('TEST_HOST_SAMPLE_INVALID');
 const low=freeMemoryMiB<3072,reservedMiB=low?512:1024+1024+512,perWorkerMiB=512;
 const memoryWorkers=Math.floor(Math.max(0,freeMemoryMiB-reservedMiB)/perWorkerMiB);
 return {workers:Math.max(0,Math.min(low?1:2,Math.max(1,cpuSlots-1),memoryWorkers)),reservedMiB,perWorkerMiB};
}
