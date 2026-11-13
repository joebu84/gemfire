// Tap every node that plays through the speakers so the host can forward
// game audio over WebRTC. Installed before the emulator creates its graph.
const taps = [];

export function installAudioTap() {
  if (installAudioTap.done) return;
  installAudioTap.done = true;
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const ret = orig.apply(this, [dest, ...rest]);
    try {
      if (dest === this.context.destination && this !== dest) {
        let tap = this.context.__gemfireTap;
        if (!tap) {
          tap = this.context.createMediaStreamDestination();
          this.context.__gemfireTap = tap;
          taps.push(tap.stream);
        }
        if (this.__gemfireTapped !== tap) {
          this.__gemfireTapped = tap;
          orig.call(this, tap);
        }
      }
    } catch (e) {
      /* a node that cannot fan out still plays locally */
    }
    return ret;
  };
}

export function audioTrack() {
  for (let i = taps.length - 1; i >= 0; i--) {
    const track = taps[i].getAudioTracks().find((t) => t.readyState === "live");
    if (track) return track;
  }
  return null;
}
