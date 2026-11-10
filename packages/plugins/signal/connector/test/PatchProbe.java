// Synthetic protocol coverage only. No account files, keys, network, or user data.
package org.asamk.signal.manager.storage.recipients;

import org.asamk.signal.manager.Manager;
import org.asamk.signal.manager.api.MessageEnvelope;
import org.asamk.signal.manager.api.SyncDeletions;
import org.asamk.signal.json.JsonMessageEnvelope;
import org.asamk.signal.util.Util;
import org.signal.core.models.ServiceId;
import org.whispersystems.signalservice.api.messages.SignalServiceContent;
import org.whispersystems.signalservice.api.messages.SignalServiceEnvelope;
import org.whispersystems.signalservice.internal.push.*;
import org.whispersystems.signalservice.internal.serialize.protos.*;
import okio.ByteString;

import java.lang.reflect.Proxy;
import java.util.*;

public final class PatchProbe implements RecipientResolver {
    private static final String SELF = "11111111-1111-4111-8111-111111111111";
    private static final String OTHER = "22222222-2222-4222-8222-222222222222";
    private final Map<Long, RecipientAddress> addresses = new HashMap<>();

    @Override public RecipientId resolveRecipient(RecipientAddress address) {
        // Model the provider's known phone-to-ACI resolution, without any network lookup.
        if (address.number().orElse("").equals("+12025550100"))
            address = new RecipientAddress((ServiceId.ACI) ServiceId.parseOrThrow(SELF), "+12025550100");
        for (var entry : addresses.entrySet()) if (entry.getValue().matches(address))
            return new RecipientId(entry.getKey(), null);
        long id = addresses.size() + 1;
        addresses.put(id, address);
        return new RecipientId(id, null);
    }
    @Override public RecipientId resolveRecipient(String value) {
        var service = ServiceId.parseOrNull(value);
        return resolveRecipient(service == null ? new RecipientAddress(value) : new RecipientAddress(service));
    }
    @Override public RecipientId resolveRecipient(ServiceId value) { return resolveRecipient(new RecipientAddress(value)); }
    @Override public RecipientId resolveRecipient(long value) { return new RecipientId(value, null); }

    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static SignalServiceContent content(SyncMessage.DeleteForMe deletion, String sender) throws Exception {
        return content(new SyncMessage.Builder().deleteForMe(deletion).build(), sender);
    }
    private static SignalServiceContent content(SyncMessage sync, String sender) throws Exception {
        var local = new AddressProto.Builder().uuid(ServiceId.parseOrThrow(SELF).toByteString()).e164("+12025550100").build();
        var address = new AddressProto.Builder().uuid(ServiceId.parseOrThrow(sender).toByteString()).build();
        var metadata = new MetadataProto.Builder().address(address).senderDevice(2).timestamp(9000L)
            .serverReceivedTimestamp(9001L).serverDeliveredTimestamp(9002L).needsReceipt(false)
            .serverGuid("33333333-3333-4333-8333-333333333333").destinationUuid(SELF).build();
        return SignalServiceContent.Companion.createFromProto(new SignalServiceContentProto.Builder()
            .localAddress(local).metadata(metadata).content(new Content.Builder()
                .syncMessage(sync).build()).build());
    }
    private static AddressableMessage target(String author, long timestamp) {
        return new AddressableMessage.Builder().authorServiceIdBinary(ServiceId.parseOrThrow(author).toByteString())
            .sentTimestamp(timestamp).build();
    }
    public static void main(String[] args) throws Exception {
        var resolver = new PatchProbe();
        org.asamk.signal.manager.helper.RecipientAddressResolver addresses = id -> resolver.addresses.get(id.id());
        var self = new ConversationIdentifier.Builder().threadServiceIdBinary(ServiceId.parseOrThrow(SELF).toByteString()).build();
        var groupBytes = ByteString.of(new byte[32]);
        var group = new ConversationIdentifier.Builder().threadGroupId(groupBytes).build();
        var deletion = new SyncMessage.DeleteForMe.Builder()
            .messageDeletes(List.of(new SyncMessage.DeleteForMe.MessageDeletes.Builder().conversation(self)
                .messages(List.of(target(SELF, 1000L))).build(),
                new SyncMessage.DeleteForMe.MessageDeletes.Builder().conversation(group)
                .messages(List.of(target(OTHER, 2000L))).build()))
            .conversationDeletes(List.of(new SyncMessage.DeleteForMe.ConversationDelete.Builder().conversation(group)
                .mostRecentMessages(List.of(target(OTHER, 2000L))).isFullDelete(true).build()))
            .attachmentDeletes(List.of(new SyncMessage.DeleteForMe.AttachmentDelete.Builder().conversation(self)
                .targetMessage(target(SELF, 3000L)).clientUuid(ByteString.of(new byte[16])).build()))
            .localOnlyConversationDeletes(List.of(new SyncMessage.DeleteForMe.LocalOnlyConversationDelete.Builder().conversation(self).build()))
            .build();
        var own = content(deletion, SELF);
        check(own != null && own.getSyncMessage().isPresent(), "authenticated typed sync missing");
        var result = SyncDeletions.from(own, resolver, addresses).orElseThrow();
        check(result.messageDeletes().size() == 2, "message deletion projection missing");
        check(result.messageDeletes().get(0).conversation().id().equals(SELF), "binary ACI conversation mismatch");
        check(result.messageDeletes().get(0).messages().get(0).author().equals(SELF), "binary ACI author mismatch");
        check(result.messageDeletes().get(1).conversation().kind().equals("group"), "group classification mismatch");
        check(result.messageDeletes().get(1).conversation().id().equals(groupBytes.base64()), "group ID mismatch");
        check(result.attachmentDeletes().get(0).targetMessage().sentTimestamp() == 3000L, "attachment target missing");
        check(result.conversationDeletes().get(0).isFullDelete(), "conversation anchor projection missing");
        check(result.localOnlyConversationDeletes().size() == 1, "local-only projection missing");

        var envelope = new SignalServiceEnvelope(new Envelope.Builder().type(Envelope.Type.DOUBLE_RATCHET)
            .sourceServiceId(SELF).sourceDeviceId(2).clientTimestamp(9000L).serverTimestamp(9001L).build(), 9002L);
        var normalized = MessageEnvelope.from(envelope, own, Map.of(), resolver, addresses, pointer -> null, null);
        check(normalized.sync().orElseThrow().deleteForMe().isPresent(), "manager normalization dropped deletion");
        var manager = (Manager) Proxy.newProxyInstance(Manager.class.getClassLoader(), new Class[]{Manager.class},
            (proxy, method, values) -> method.getName().equals("getContactOrProfileName") ? "Synthetic" : null);
        var json = Util.createJsonObjectMapper().writeValueAsString(JsonMessageEnvelope.from(normalized, null, manager));
        var tree = Util.createJsonObjectMapper().readTree(json);
        check(tree.path("syncMessage").path("deleteForMe").path("messageDeletes").get(0)
            .path("messages").get(0).path("sentTimestamp").asLong() == 1000L, "JSON lost target");
        check(!json.contains("localAddress") && !json.contains("serializedState") && !json.contains("metadata"), "raw state leaked");

        var phoneDelete = new SyncMessage.DeleteForMe.Builder().messageDeletes(List.of(new SyncMessage.DeleteForMe.MessageDeletes.Builder()
            .conversation(new ConversationIdentifier.Builder().threadE164("+12025550100").build())
            .messages(List.of(new AddressableMessage.Builder().authorE164("+12025550100").sentTimestamp(4000L).build())).build())).build();
        var phone = SyncDeletions.from(content(phoneDelete, SELF), resolver, addresses).orElseThrow().messageDeletes().get(0);
        check(phone.conversation().id().equals(SELF) && phone.messages().get(0).author().equals(SELF), "known phone alias was not canonicalized");
        var pni = "PNI:" + SELF;
        var pniDelete = new SyncMessage.DeleteForMe.Builder().messageDeletes(List.of(new SyncMessage.DeleteForMe.MessageDeletes.Builder()
            .conversation(new ConversationIdentifier.Builder().threadServiceIdBinary(ServiceId.parseOrThrow(pni).toByteString()).build())
            .messages(List.of(target(pni, 5000L))).build())).build();
        var pniProjection = SyncDeletions.from(content(pniDelete, SELF), resolver, addresses).orElseThrow().messageDeletes().get(0);
        check(!pniProjection.conversation().id().equals(SELF) && !pniProjection.messages().get(0).author().equals(SELF), "PNI confused with ACI");
        check(SyncDeletions.from(content(deletion, OTHER), resolver, addresses).isEmpty(), "foreign sync authorized deletion");
        // iOS syncs a view-once placeholder with its original timestamp and flag,
        // but deliberately omits the photo body and attachments.
        var viewOnce = content(new SyncMessage.Builder().sent(new SyncMessage.Sent.Builder()
            .timestamp(9000L).destinationServiceIdBinary(ServiceId.parseOrThrow(SELF).toByteString())
            .message(new DataMessage.Builder().timestamp(9000L).isViewOnce(true)
                .requiredProtocolVersion(3).build()).build()).build(), SELF);
        check(viewOnce.getSyncMessage().orElseThrow().getSent().orElseThrow().getDataMessage()
            .orElseThrow().isViewOnce(), "library dropped view-once flag");
        var viewOnceEnvelope = MessageEnvelope.from(envelope, viewOnce, Map.of(), resolver, addresses, pointer -> null, null);
        check(viewOnceEnvelope.sync().orElseThrow().sent().orElseThrow().message().orElseThrow()
            .isViewOnce(), "manager dropped view-once flag");
        var viewOnceJson = Util.createJsonObjectMapper().valueToTree(JsonMessageEnvelope.from(viewOnceEnvelope, null, manager))
            .path("syncMessage").path("sentMessage");
        check(viewOnceJson.path("viewOnce").asBoolean(), "JSON dropped view-once flag");
        check(viewOnceJson.path("timestamp").asLong() == 9000L, "JSON lost view-once timestamp");
        check(viewOnceJson.path("destinationUuid").asText().equals(SELF), "JSON lost view-once destination");
        check(viewOnceJson.path("message").isNull() && !viewOnceJson.has("attachments"), "view-once placeholder gained content");
        System.out.println("Patched real protobuf -> authenticated content -> manager -> JSON: passed");
    }
}
