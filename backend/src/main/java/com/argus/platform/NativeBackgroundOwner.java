package com.argus.platform;

/**
 * A native producer must stop admission, cancel owned work, and join completion before returning.
 */
public interface NativeBackgroundOwner {
  String ownerName();

  int shutdownOrder();

  void quiesce();
}
