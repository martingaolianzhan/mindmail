import useThreads from "~/hooks/use-threads";
import { api } from "~/trpc/react";
import { RecipientInput, type RecipientInputProps } from "./recipient-input";

/** Production suggestion adapter; Demo supplies its own data-only adapter. */
const TagInput = (props: RecipientInputProps) => {
    const { accountId } = useThreads();
    const { data: suggestions } = api.account.getEmailAddressSuggesstions.useQuery({ accountId });
    return <RecipientInput {...props} suggestions={suggestions} />;
};

export default TagInput;
