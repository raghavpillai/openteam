// OpenTeam-authored compatibility projection for signal-cli 0.14.10. GPL-3.0-only.
package org.asamk.signal.manager.api;

import org.asamk.signal.manager.helper.RecipientAddressResolver;
import org.asamk.signal.manager.storage.recipients.RecipientResolver;
import org.signal.core.models.ServiceId;
import org.whispersystems.signalservice.api.messages.SignalServiceContent;
import org.whispersystems.signalservice.internal.push.AddressableMessage;
import org.whispersystems.signalservice.internal.push.ConversationIdentifier;
import org.whispersystems.signalservice.internal.serialize.protos.SignalServiceContentProto;
import okio.ByteString;

import java.io.IOException;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Function;

/** Only deletion addressing metadata crosses this boundary, never serialized content or keys. */
public record SyncDeletions(
        List<MessageDeletes> messageDeletes,
        List<ConversationDelete> conversationDeletes,
        List<LocalOnlyConversationDelete> localOnlyConversationDeletes,
        List<AttachmentDelete> attachmentDeletes
) {
    public record Conversation(String kind, String id) {}
    public record Target(String author, long sentTimestamp) {}
    public record MessageDeletes(Conversation conversation, List<Target> messages) {}
    public record ConversationDelete(Conversation conversation, List<Target> mostRecentMessages,
            List<Target> mostRecentNonExpiringMessages, boolean isFullDelete) {}
    public record LocalOnlyConversationDelete(Conversation conversation) {}
    public record AttachmentDelete(Conversation conversation, Target targetMessage,
            String clientUuid, String fallbackDigest, String fallbackPlaintextHash) {}

    public static Optional<SyncDeletions> from(SignalServiceContent content,
            RecipientResolver recipients, RecipientAddressResolver addresses) {
        // SignalServiceContent creates typed sync messages only for authenticated own-device senders.
        // Never recover deletion data from an unauthenticated/ordinary data envelope.
        if (content == null || content.getSyncMessage().isEmpty()) return Optional.empty();
        try {
            var serialized = SignalServiceContentProto.ADAPTER.decode(content.serialize());
            var sync = serialized.content == null ? null : serialized.content.syncMessage;
            var deletion = sync == null ? null : sync.deleteForMe;
            if (deletion == null) return Optional.empty();
            Function<ConversationIdentifier, Conversation> conversation = value -> conversation(value, recipients, addresses);
            Function<AddressableMessage, Target> target = value -> target(value, recipients, addresses);
            return Optional.of(new SyncDeletions(
                deletion.messageDeletes.stream().map(value -> new MessageDeletes(conversation.apply(value.conversation),
                        value.messages.stream().map(target).filter(Objects::nonNull).toList()))
                    .filter(value -> value.conversation() != null && !value.messages().isEmpty()).toList(),
                deletion.conversationDeletes.stream().map(value -> new ConversationDelete(conversation.apply(value.conversation),
                        value.mostRecentMessages.stream().map(target).filter(Objects::nonNull).toList(),
                        value.mostRecentNonExpiringMessages.stream().map(target).filter(Objects::nonNull).toList(),
                        Boolean.TRUE.equals(value.isFullDelete)))
                    .filter(value -> value.conversation() != null).toList(),
                deletion.localOnlyConversationDeletes.stream().map(value -> new LocalOnlyConversationDelete(conversation.apply(value.conversation)))
                    .filter(value -> value.conversation() != null).toList(),
                deletion.attachmentDeletes.stream().map(value -> new AttachmentDelete(conversation.apply(value.conversation),
                        target.apply(value.targetMessage), base64(value.clientUuid), base64(value.fallbackDigest), base64(value.fallbackPlaintextHash)))
                    .filter(value -> value.conversation() != null && value.targetMessage() != null).toList()));
        } catch (IOException exception) {
            // A pinned runtime must preserve its own serialized content. Do not silently claim deletion support.
            throw new IllegalStateException("Could not decode authenticated Signal sync metadata", exception);
        }
    }

    private static String base64(ByteString bytes) {
        return bytes == null ? null : bytes.base64();
    }

    private static String contact(String text, ByteString binary, String phone,
            RecipientResolver recipients, RecipientAddressResolver addresses) {
        var serviceId = ServiceId.parseOrNull(text, binary);
        if (serviceId == null && (phone == null || !phone.matches("\\+[1-9][0-9]{1,14}"))) return null;
        var id = serviceId == null ? recipients.resolveRecipient(phone) : recipients.resolveRecipient(serviceId);
        return addresses.resolveRecipientAddress(id).toApiRecipientAddress().getIdentifier();
    }

    private static Conversation conversation(ConversationIdentifier value,
            RecipientResolver recipients, RecipientAddressResolver addresses) {
        if (value == null) return null;
        if (value.threadGroupId != null) {
            byte[] bytes = value.threadGroupId.toByteArray();
            if (bytes.length != 16 && bytes.length != 32) return null;
            return new Conversation("group", GroupId.unknownVersion(bytes).toBase64());
        }
        var id = contact(value.threadServiceId, value.threadServiceIdBinary, value.threadE164, recipients, addresses);
        return id == null ? null : new Conversation("contact", id);
    }

    private static Target target(AddressableMessage value,
            RecipientResolver recipients, RecipientAddressResolver addresses) {
        if (value == null || value.sentTimestamp == null || value.sentTimestamp <= 0 || value.sentTimestamp > 9_007_199_254_740_991L)
            return null;
        var author = contact(value.authorServiceId, value.authorServiceIdBinary, value.authorE164, recipients, addresses);
        return author == null ? null : new Target(author, value.sentTimestamp);
    }
}
