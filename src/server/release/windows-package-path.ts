// Shared lexical Windows filename rule. Secret/source policy stays with each package.
export function isWindowsPackageSegment(value:string):boolean {
  return !!value&&value!=='.'&&value!=='..'&&!/[\x00-\x1f<>:"|?*\\/]/.test(value)&&
    !/[. ]$/.test(value)&&!/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(value);
}
