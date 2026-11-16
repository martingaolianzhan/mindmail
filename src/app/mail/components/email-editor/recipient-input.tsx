import Avatar from "react-avatar";
import Select from "react-select";
import React from "react";

export type RecipientInputProps = {
    placeholder: string;
    label: string;
    onChange: (values: { label: string; value: string }[]) => void;
    value: { label: string; value: string }[];
};

type Props = RecipientInputProps & {
    suggestions?: { address: string }[];
    showAvatars?: boolean;
};

/** Recipient presentation only. Suggestions are supplied by the owning adapter. */
export function RecipientInput({ placeholder, label, onChange, value, suggestions, showAvatars = true }: Props) {
    const [inputValue, setInputValue] = React.useState('');
    const options = suggestions?.map(suggestion => ({
        label: showAvatars ? <span className="flex items-center gap-2">
            <Avatar name={suggestion.address} size="25" textSizeRatio={2} round={true} />
            {suggestion.address}
        </span> : suggestion.address,
        value: suggestion.address,
    }));
    return <div className="border rounded-md flex items-center">
        <span className="ml-3 text-sm text-grey-500">{label}</span>
        <Select
            aria-label={label}
            onInputChange={setInputValue}
            value={value}
            // @ts-expect-error: preserve the existing React-node option-label boundary.
            onChange={onChange}
            placeholder={placeholder}
            isMulti
            className="w-full flex-1"
            // @ts-expect-error: selected values use string labels; suggestion labels may be React nodes.
            options={inputValue ? options?.concat({ label: inputValue, value: inputValue }) : options}
            classNames={{
                control: () => '!border-none !outline-none !ring-0 !shadow-none focus:border-none focus:outline-none focus:ring-0 focus:shadow-none dark:bg-transparent',
                multiValue: () => 'dark:!bg-gray-700',
                multiValueLabel: () => 'dark:bg-gray-700 dark:text-white rounded-md',
                menu: () => 'dark:bg-gray-700',
                option: () => 'dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600',
                input: () => 'dark:text-gray-300',
            }}
            classNamePrefix="react-select"
        />
    </div>;
}
