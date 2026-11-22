/** Two-link leg in the Y/Z plane. Angles are relative to the imported rest pose. */
export function solveLeg(upper: {y:number;z:number}, lower: {y:number;z:number}, target: {y:number;z:number}) {
  const a=Math.hypot(upper.y,upper.z), b=Math.hypot(lower.y,lower.z);
  const d=Math.min(a+b-1e-6,Math.max(Math.abs(a-b)+1e-6,Math.hypot(target.y,target.z)));
  const u=Math.atan2(upper.z,-upper.y), l=Math.atan2(lower.z,-lower.y);
  const bend=Math.acos(Math.max(-1,Math.min(1,(d*d-a*a-b*b)/(2*a*b))));
  const beta=(l-u<0 ? -1 : 1)*bend;
  const alpha=Math.atan2(target.z,-target.y)-Math.atan2(b*Math.sin(beta),a+b*Math.cos(beta));
  return {hip:u-alpha,knee:l-u-beta};
}

/** Half cycle planted, half cycle lifted; stance travel cancels body translation. */
export function footCycle(phase:number) {
  const u=((phase/(2*Math.PI))%1+1)%1;
  if(u<.5) return {stride:.5-2*u,lift:0};
  const t=2*u-1, smooth=t*t*(3-2*t);
  return {stride:-.5+smooth,lift:Math.sin(Math.PI*t)**2};
}
