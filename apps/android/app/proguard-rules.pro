-keepattributes Signature,InnerClasses,EnclosingMethod
-dontwarn javax.annotation.**
# Nimbus references an optional XC20P provider. Wire accepts only A256GCM;
# this algorithm is unreachable and Tink is deliberately not bundled.
-dontwarn com.google.crypto.tink.subtle.XChaCha20Poly1305
